/* eslint-disable @typescript-eslint/no-use-before-define */
import { BgsPostMatchStats, parseBattlegroundsGame } from '@firestone-hs/hs-replay-xml-parser/dist/public-api';
import { deflate } from 'pako';
import { ServerlessMysql } from 'serverless-mysql';
import SqlString from 'sqlstring';
import { getConnection } from './db/rds';
import { getConnection as getConnectionBgs } from './db/rds-bgs';
import { S3 } from './db/s3';
import { Sns } from './db/sns';
import { BgsBestStat } from './model/bgs-best-stat';
import { Input } from './sqs-event';
import { buildNewStats } from './stats-builder';

const s3 = new S3();
const sns = new Sns();

export default async (event, context): Promise<any> => {
	const events: readonly Input[] = (event.Records as any[])
		.map(event => JSON.parse(event.body))
		.reduce((a, b) => a.concat(b), [])
		.filter(event => event);
	const mysql = await getConnection();
	const mysqlBgs = await getConnectionBgs();
	for (const ev of events) {
		await processEvent(ev, mysql, mysqlBgs);
	}
	const response = {
		statusCode: 200,
		isBase64Encoded: false,
		body: null,
	};
	await mysql.end();
	await mysqlBgs.end();
	return response;
};

const processEvent = async (input: Input, mysql: ServerlessMysql, mysqlBgs: ServerlessMysql) => {
	const debug = input.userName === 'daedin';
	console.log('processing review', input.reviewId);

	const review = await loadReview(input.reviewId, mysql);
	console.log('loaded review', input.reviewId);
	if (!review) {
		// We log the error, and acknowledge.
		// The idea is to not corrupt the reporting with the occasional glitch that happens when
		// saving a review
		console.error('could not load review', input.reviewId);
		return;
	}

	const gameMode = review.gameMode;
	if (gameMode !== 'battlegrounds') {
		console.log('invalid non-BG review received', review);
		return;
	}

	const replayKey = review.replayKey;
	const replayXml = await loadReplayString(replayKey);
	console.log('loaded replayXml', replayXml?.length);
	if (!replayXml?.length) {
		console.log('invalid replay');
		return;
	}

	const postMatchStats = parseBattlegroundsGame(
		replayXml,
		input.mainPlayer,
		input.battleResultHistory,
		input.faceOffs,
	);
	console.log('parsed battlegrounds game', input.mainPlayer, input.battleResultHistory, input.faceOffs);
	if (!postMatchStats) {
		console.error('Could not parse post-match stats', input.reviewId);
		return;
	}

	console.log('warband stats', input.reviewId, postMatchStats.totalStatsOverTurn);

	const oldMmr = input.oldMmr;
	const newMmr = input.newMmr;

	const statsWithMmr: any = {
		...postMatchStats,
		oldMmr: oldMmr,
		newMmr: newMmr,
	};
	const compressedStats: string = compressPostMatchStats(statsWithMmr, 51000);

	const userName = input.userName ? `'${input.userName}'` : 'NULL';
	const heroCardId = input.heroCardId ? `'${input.heroCardId}'` : 'NULL';
	const query = `
		INSERT IGNORE INTO bgs_single_run_stats
		(
			reviewId,
			jsonStats,
			userId,
			userName,
			heroCardId
		)
		VALUES
		(
			${SqlString.escape(input.reviewId)},
			'${compressedStats}',
			${SqlString.escape(input.userId)},
			${userName},
			${heroCardId}
		)
	`;
	console.log('running query', query);
	const dbResults: any[] = await mysqlBgs.query(query);

	if (input.userId) {
		const userSelectQuery = `
					SELECT DISTINCT userId FROM user_mapping
					INNER JOIN (
						SELECT DISTINCT username FROM user_mapping
						WHERE 
							(username = '${input.userName}' OR username = '${input.userId}' OR userId = '${input.userId}')
							AND username IS NOT NULL
							AND username != ''
							AND username != 'null'
					) AS x ON x.username = user_mapping.username
					UNION ALL SELECT '${input.userId}'
				`;
		const userIds: any[] = await mysql.query(userSelectQuery);

		// Load existing stats
		const query = `
			SELECT * FROM bgs_user_best_stats
			WHERE userId IN (${userIds.map(result => "'" + result.userId + "'").join(',')})
		`;
		const existingStats: BgsBestStat[] = await mysqlBgs.query(query);

		const today = toCreationDate(new Date());
		const newStats: readonly BgsBestStat[] = buildNewStats(existingStats, postMatchStats, input, today);
		const statsToCreate = newStats
			.filter(stat => !stat.id)
			.filter(stat => !isNaN(stat.value) && isFinite(stat.value));
		const statsToUpdate = newStats
			.filter(stat => stat.id)
			.filter(stat => !isNaN(stat.value) && isFinite(stat.value));

		const createQuery =
			statsToCreate.length > 0
				? `
						INSERT INTO bgs_user_best_stats
						(userId, statName, value, lastUpdateDate, reviewId)
						VALUES 
							${statsToCreate.map(stat => toStatCreationLine(stat, today)).join(',\n')}
					`
				: null;
		const updateQueries = statsToUpdate.map(
			stat => `
						UPDATE bgs_user_best_stats
						SET 
							value = ${stat.value},
							heroCardId = '${stat.heroCardId}',
							lastUpdateDate = '${today}',
							reviewId = '${input.reviewId}'
						WHERE
							id = ${stat.id}
					`,
		);
		const allQueries = [createQuery, ...updateQueries].filter(query => query);
		await Promise.all(allQueries.map(query => mysqlBgs.query(query)));
		statsWithMmr.updatedBestValues = newStats;
	}

	const compressedFinalBoard = postMatchStats.boardHistory?.length
		? compressStats(postMatchStats.boardHistory[postMatchStats.boardHistory.length - 1])
		: null;
	if (compressedFinalBoard) {
		const query = `
			UPDATE replay_summary
			SET finalComp = ${SqlString.escape(compressedFinalBoard)}
			WHERE reviewId = ${SqlString.escape(review.reviewId)}
		`;
		console.log('running query', query);
		const result = await mysql.query(query);
		console.log('result', result);
	}

	if (isPerfectGame(review, postMatchStats)) {
		await sns.notifyBgPerfectGame(review);
		const query = `
			UPDATE replay_summary
			SET bgsPerfectGame = 1
			WHERE reviewId = ${SqlString.escape(review.reviewId)}
		`;
		console.log('running query', query);
		const result = await mysql.query(query);
		console.log('result', result);
	}

	// And update the bgs_run_stats table
	const winrates = postMatchStats.battleResultHistory.map(info => ({
		turn: info.turn,
		winrate: info.simulationResult.wonPercent,
	}));
	console.log('winrates', review.reviewId, winrates?.length);
	if (winrates.length) {
		const query = `
			UPDATE bgs_run_stats
			SET combatWinrate = ${SqlString.escape(JSON.stringify(winrates))}
			WHERE reviewId = ${SqlString.escape(review.reviewId)}
		`;
		console.log('running query', query);
		const result = await mysql.query(query);
		console.log('result', result);
	} else {
		console.log('no winrates', review.reviewId, winrates, postMatchStats.battleResultHistory);
	}
};

export const isPerfectGame = (review: any, postMatchStats: BgsPostMatchStats): boolean => {
	if (!review.additionalResult || parseInt(review.additionalResult) !== 1) {
		return false;
	}

	const mainPlayerCardId = review.playerCardId;
	const mainPlayerHpOverTurn = postMatchStats.hpOverTurn[mainPlayerCardId];
	// Let's use 8 turns as a minimum to be considered a perfect game
	if (!mainPlayerHpOverTurn?.length || mainPlayerHpOverTurn.length < 8) {
		return false;
	}

	const startingHp = mainPlayerHpOverTurn[0].value;
	const endHp = mainPlayerHpOverTurn[mainPlayerHpOverTurn.length - 1].value;
	return endHp === startingHp;
};

const compressPostMatchStats = (postMatchStats: BgsPostMatchStats, maxLength: number): string => {
	const base64data = compressStats(postMatchStats);
	if (base64data.length < maxLength) {
		return base64data;
	}

	console.warn('stats too big, compressing', base64data.length);
	const boardWithOnlyLastTurn =
		postMatchStats.boardHistory && postMatchStats.boardHistory.length > 0
			? [postMatchStats.boardHistory[postMatchStats.boardHistory.length - 1]]
			: [];
	const truncatedStats: any = {
		...postMatchStats,
		boardHistory: boardWithOnlyLastTurn,
	};
	const compressedTruncatedStats = deflate(JSON.stringify(truncatedStats), { to: 'string' });
	const buffTruncated = Buffer.from(compressedTruncatedStats, 'utf8');
	const base64dataTruncated = buffTruncated.toString('base64');
	return base64dataTruncated;
};

const compressStats = (stats: any): string => {
	const compressedStats = deflate(JSON.stringify(stats), { to: 'string' });
	const buff = Buffer.from(compressedStats, 'utf8');
	const base64data = buff.toString('base64');
	return base64data;
};

const toStatCreationLine = (stat: BgsBestStat, today: string): string => {
	return `(
		${SqlString.escape(stat.userId)}, 
		${SqlString.escape(stat.statName)}, 
		${SqlString.escape(stat.value)}, 
		${SqlString.escape(today)}, 
		${SqlString.escape(stat.reviewId)}
	)`;
};

const loadReview = async (reviewId: string, mysql: ServerlessMysql) => {
	return new Promise<any>(resolve => {
		loadReviewInternal(reviewId, mysql, review => resolve(review));
	});
};

const loadReviewInternal = async (reviewId: string, mysql: ServerlessMysql, callback, retriesLeft = 15) => {
	if (retriesLeft <= 0) {
		console.error('Could not load review', reviewId);
		callback(null);
		return;
	}
	const dbResults: any[] = await mysql.query(
		`
		SELECT * FROM replay_summary 
		WHERE reviewId = '${reviewId}'
	`,
	);
	const review = dbResults && dbResults.length > 0 ? dbResults[0] : null;
	if (!review) {
		setTimeout(() => loadReviewInternal(reviewId, mysql, callback, retriesLeft - 1), 1000);
		return;
	}
	callback(review);
};

const loadReplayString = async (replayKey: string): Promise<string> => {
	return new Promise<string>(resolve => {
		loadReplayStringInternal(replayKey, replayString => resolve(replayString));
	});
};

const loadReplayStringInternal = async (replayKey: string, callback, retriesLeft = 15): Promise<string> => {
	if (retriesLeft <= 0) {
		console.error('Could not load replay xml', replayKey);
		callback(null);
		return;
	}
	const data = replayKey.endsWith('.zip')
		? await s3.readZippedContent('xml.firestoneapp.com', replayKey)
		: await s3.readContentAsString('xml.firestoneapp.com', replayKey);
	// const data = await http(`https://s3-us-west-2.amazonaws.com/xml.firestoneapp.com/${replayKey}`);
	// If there is nothing, we get the S3 "no key found" error
	if (!data || data.length < 5000) {
		setTimeout(() => loadReplayStringInternal(replayKey, callback, retriesLeft - 1), 500);
		return;
	}
	callback(data);
};

const toCreationDate = (today: Date): string => {
	return `${today
		.toISOString()
		.slice(0, 19)
		.replace('T', ' ')}.${today.getMilliseconds()}`;
};

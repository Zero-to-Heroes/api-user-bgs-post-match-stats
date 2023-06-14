/* eslint-disable @typescript-eslint/no-use-before-define */
import { getConnection, logBeforeTimeout, logger, S3, Sns } from '@firestone-hs/aws-lambda-utils';
import { BgsPostMatchStats, parseBattlegroundsGame } from '@firestone-hs/hs-replay-xml-parser/dist/public-api';
import { AllCardsService } from '@firestone-hs/reference-data';
import { deflate } from 'pako';
import { ServerlessMysql } from 'serverless-mysql';
import SqlString from 'sqlstring';
import { BgsBestStat } from './model/bgs-best-stat';
import { Input } from './sqs-event';
import { buildNewStats } from './stats-builder';

const s3 = new S3();
const sns = new Sns();
const allCards = new AllCardsService();

export default async (event, context): Promise<any> => {
	const cleanup = logBeforeTimeout(context);
	await allCards.initializeCardsDb();
	const events: readonly Input[] = (event.Records as any[])
		.map((event) => JSON.parse(event.body))
		.reduce((a, b) => a.concat(b), [])
		.filter((event) => event);
	const mysql = await getConnection();
	for (const ev of events) {
		await processEvent(ev, mysql, allCards);
	}
	const response = {
		statusCode: 200,
		isBase64Encoded: false,
		body: null,
	};
	await mysql.end();
	cleanup();
	return response;
};

const processEvent = async (input: Input, mysql: ServerlessMysql, allCards: AllCardsService) => {
	logger.debug('processing review', input.reviewId);

	const review = await loadReview(input.reviewId, mysql);
	logger.debug('loaded review', input.reviewId);
	if (!review) {
		// We log the error, and acknowledge.
		// The idea is to not corrupt the reporting with the occasional glitch that happens when
		// saving a review
		logger.error('could not load review', input.reviewId);
		return;
	}

	const gameMode = review.gameMode;
	if (gameMode !== 'battlegrounds') {
		logger.debug('invalid non-BG review received', review);
		return;
	}

	const replayKey = review.replayKey;
	const replayXml = await loadReplayString(replayKey);
	logger.debug('loaded replayXml', replayXml?.length);
	if (!replayXml?.length) {
		logger.debug('invalid replay');
		return;
	}

	const postMatchStats = parseBattlegroundsGame(
		replayXml,
		input.mainPlayer,
		input.battleResultHistory,
		input.faceOffs,
		allCards,
	);
	logger.debug('parsed battlegrounds game', input.mainPlayer, input.battleResultHistory, input.faceOffs);
	if (!postMatchStats) {
		logger.error('Could not parse post-match stats', input.reviewId);
		return;
	}

	logger.debug('warband stats', input.reviewId, postMatchStats.totalStatsOverTurn);

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
	logger.debug('running query', query);
	const dbResults: any[] = await mysql.query(query);
	// const dbResults: any[] = await mysqlBgs.query(query);

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
			WHERE userId IN (${userIds.map((result) => "'" + result.userId + "'").join(',')})
		`;
		const existingStats: BgsBestStat[] = await mysql.query(query);

		const today = toCreationDate(new Date());
		const newStats: readonly BgsBestStat[] = buildNewStats(existingStats, postMatchStats, input, today);
		const statsToCreate = newStats
			.filter((stat) => !stat.id)
			.filter((stat) => !isNaN(stat.value) && isFinite(stat.value));
		const statsToUpdate = newStats
			.filter((stat) => stat.id)
			.filter((stat) => !isNaN(stat.value) && isFinite(stat.value));

		const createQuery =
			statsToCreate.length > 0
				? `
						INSERT INTO bgs_user_best_stats
						(userId, statName, value, lastUpdateDate, reviewId)
						VALUES 
							${statsToCreate.map((stat) => toStatCreationLine(stat, today)).join(',\n')}
					`
				: null;
		const updateQueries = statsToUpdate.map(
			(stat) => `
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
		const allQueries = [createQuery, ...updateQueries].filter((query) => query);
		await Promise.all(allQueries.map((query) => mysql.query(query)));
		// await Promise.all(allQueries.map(query => mysqlBgs.query(query)));
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
		logger.debug('running query', query);
		const result = await mysql.query(query);
		logger.debug('result', result);
	}

	if (isPerfectGame(review, postMatchStats)) {
		await sns.notifyBgPerfectGame(review);
		const query = `
			UPDATE replay_summary
			SET bgsPerfectGame = 1
			WHERE reviewId = ${SqlString.escape(review.reviewId)}
		`;
		logger.debug('running query', query);
		const result = await mysql.query(query);
		logger.debug('result', result);
	}

	// And update the bgs_run_stats table
	const winrates = postMatchStats.battleResultHistory.map((info) => ({
		turn: info.turn,
		winrate: info.simulationResult.wonPercent,
	}));
	logger.debug('winrates', review.reviewId, winrates?.length);
	if (winrates.length) {
		const query = `
			UPDATE bgs_run_stats
			SET combatWinrate = ${SqlString.escape(JSON.stringify(winrates))}
			WHERE reviewId = ${SqlString.escape(review.reviewId)}
		`;
		logger.debug('running query', query);
		const result = await mysql.query(query);
		logger.debug('result', result);
	} else {
		logger.debug('no winrates', review.reviewId, winrates, postMatchStats.battleResultHistory);
	}
};

// TODO: why is it here? It shoud be done in the main parser
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

	logger.warn('stats too big, compressing', base64data.length);
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
	return new Promise<any>((resolve) => {
		loadReviewInternal(reviewId, mysql, (review) => resolve(review));
	});
};

const loadReviewInternal = async (reviewId: string, mysql: ServerlessMysql, callback, retriesLeft = 15) => {
	if (retriesLeft <= 0) {
		logger.error('Could not load review', reviewId);
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
	return new Promise<string>((resolve) => {
		loadReplayStringInternal(replayKey, (replayString) => resolve(replayString));
	});
};

const loadReplayStringInternal = async (replayKey: string, callback): Promise<string> => {
	const data = replayKey.endsWith('.zip')
		? await s3.readZippedContent('xml.firestoneapp.com', replayKey)
		: await s3.readContentAsString('xml.firestoneapp.com', replayKey);
	// const data = await http(`https://s3-us-west-2.amazonaws.com/xml.firestoneapp.com/${replayKey}`);
	// If there is nothing, we get the S3 "no key found" error
	if (!data || data.length < 5000) {
		logger.error('Could not load replay xml', replayKey, data);
		callback(null);
		return;
	}
	callback(data);
};

const toCreationDate = (today: Date): string => {
	return `${today.toISOString().slice(0, 19).replace('T', ' ')}.${today.getMilliseconds()}`;
};

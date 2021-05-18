import { inflate } from 'pako';
import SqlString from 'sqlstring';
import { gzipSync } from 'zlib';
import { getConnection } from './db/rds';
import { getConnection as getConnectionBgs } from './db/rds-bgs';
import { Input } from './sqs-event';

export default async (event): Promise<any> => {
	const input: Input = JSON.parse(event.body);
	if (input.reviewId) {
		return await handleSinglReviewRetrieve(input);
	} else {
		return await handleMultiReviewsRetrieve(input);
	}
};

const handleSinglReviewRetrieve = async (input: Input): Promise<any> => {
	const escape = SqlString.escape;
	let query = `
		SELECT * FROM bgs_single_run_stats
		WHERE reviewId = ${escape(input.reviewId)}
	`;
	const mysqlBgs = await getConnectionBgs();
	let rawResults: any[] = (await mysqlBgs.query(query)) as any[];
	if (!rawResults.length) {
		const pgQuery = `
			SELECT * FROM bgs_perfect_game
			WHERE reviewId = ${escape(input.reviewId)}
		`;
		const mysql = await getConnection();
		const pgResults: any[] = (await mysql.query(pgQuery)) as any[];
		if (!pgResults.length) {
			console.error('No post match info for review', input);
			return {
				statusCode: 404,
			};
		}

		const originalReviewId = pgResults.length ? pgResults[0].originalReviewId : '__invalid__';
		query = `
			SELECT * FROM bgs_single_run_stats
			WHERE reviewId = ${escape(originalReviewId)}
		`;
		rawResults = (await mysqlBgs.query(query)) as any[];
	}

	const results: any[] = rawResults
		.filter(result => result.jsonStats && result.jsonStats.length <= 50000)
		.map(result => {
			const stats = parseStats(result.jsonStats);
			return {
				reviewId: result.reviewId,
				stats: stats,
				userId: null,
				userName: null,
			};
		})
		.filter(result => result.stats);
	await mysqlBgs.end();

	const zipped = await zip(JSON.stringify(results));
	const response = {
		statusCode: 200,
		isBase64Encoded: true,
		body: zipped,
		headers: {
			'Content-Type': 'text/html',
			'Content-Encoding': 'gzip',
		},
	};
	return response;
};

const handleMultiReviewsRetrieve = async (input: Input): Promise<any> => {
	const escape = SqlString.escape;
	const heroCardCriteria = input.heroCardId ? `AND heroCardId = ${escape(input.heroCardId)} ` : '';
	const usernameCriteria = input.userName ? `OR userName = ${escape(input.userName)}` : '';
	const query = `
		SELECT * FROM bgs_single_run_stats
		WHERE (userId = ${escape(input.userId)} ${usernameCriteria})
		${heroCardCriteria}
		ORDER BY id DESC
	`;

	const mysql = await getConnectionBgs();
	const rawResults: any[] = (await mysql.query(query)) as any[];

	const results: any[] = rawResults
		.filter(result => result.jsonStats && result.jsonStats.length <= 50000)
		.map(result => {
			const stats = parseStats(result.jsonStats);
			return {
				reviewId: result.reviewId,
				stats: stats,
			};
		})
		.filter(result => result.stats);
	await mysql.end();

	const zipped = await zip(JSON.stringify(results));
	const response = {
		statusCode: 200,
		isBase64Encoded: true,
		body: zipped,
		headers: {
			'Content-Type': 'text/html',
			'Content-Encoding': 'gzip',
		},
	};
	return response;
};

const zip = async (input: string) => {
	return gzipSync(input).toString('base64');
};

const parseStats = (inputStats: string): string => {
	try {
		const parsed = JSON.parse(inputStats);
		return parsed;
	} catch (e) {
		try {
			const fromBase64 = Buffer.from(inputStats, 'base64').toString();
			const inflated = inflate(fromBase64, { to: 'string' });
			return JSON.parse(inflated);
		} catch (e) {
			console.warn('Could not build full stats, ignoring review', inputStats);
			return null;
		}
	}
};

import { inflate } from 'pako';
import SqlString from 'sqlstring';
import { gzipSync } from 'zlib';
import { getConnection as getConnectionBgs } from './db/rds-bgs';
import { Input } from './sqs-event';

export default async (event): Promise<any> => {
	const input: Input = JSON.parse(event.body);

	const query = buildQuery(input);

	const mysql = await getConnectionBgs();
	const results: any[] = ((await mysql.query(query)) as any[])
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

const buildQuery = (input: Input): string => {
	const escape = SqlString.escape;
	if (input.reviewId) {
		return `
			SELECT * FROM bgs_single_run_stats
			WHERE reviewId = ${escape(input.reviewId)}
		`;
	} else {
		const heroCardCriteria = input.heroCardId ? `AND heroCardId = ${escape(input.heroCardId)} ` : '';
		const usernameCriteria = input.userName ? `OR userName = ${escape(input.userName)}` : '';
		return `
			SELECT * FROM bgs_single_run_stats
			WHERE (userId = ${escape(input.userId)} ${usernameCriteria})
			${heroCardCriteria}
			ORDER BY id DESC
		`;
	}
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

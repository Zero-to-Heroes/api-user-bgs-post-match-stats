import { StatName } from './stat-name.type';

export interface BgsBestStat {
	id: number;
	userId: string;
	statName: StatName;
	value: number;
	heroCardId: string;
	lastUpdateDate: string;
	reviewId: string;
}

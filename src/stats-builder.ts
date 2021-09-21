/* eslint-disable @typescript-eslint/no-use-before-define */
import { BgsPostMatchStats } from '@firestone-hs/hs-replay-xml-parser/dist/public-api';
import { CardIds } from '@firestone-hs/reference-data';
import { BgsBestStat } from './model/bgs-best-stat';
import { StatName } from './model/stat-name.type';
import { Input } from './sqs-event';

const statsConfig: { [statName: string]: (postMatchStats: BgsPostMatchStats, input: Input) => number } = {
	totalDamageDealtToMinions: (postMatchStats: BgsPostMatchStats, input: Input): number =>
		Object.keys(postMatchStats.totalMinionsDamageDealt)
			.filter(cardId => cardId !== input.mainPlayer?.cardId)
			.map(cardId => postMatchStats.totalMinionsDamageDealt[cardId])
			.reduce((a, b) => a + b, 0),
	totalDamageTakenByMinions: (postMatchStats: BgsPostMatchStats, input: Input): number =>
		Object.keys(postMatchStats.totalMinionsDamageTaken)
			.filter(cardId => cardId !== input.mainPlayer?.cardId)
			.map(cardId => postMatchStats.totalMinionsDamageTaken[cardId])
			.reduce((a, b) => a + b, 0),
	totalDamageDealtToHeroes: (postMatchStats: BgsPostMatchStats, input: Input): number =>
		postMatchStats.damageToEnemyHeroOverTurn
			.filter(info => info.value.enemyHeroCardId !== CardIds.KelthuzadBattlegrounds)
			.map(info => (info.value.value != null ? info.value.value : ((info.value as any) as number))) // For backward compatibility
			.reduce((a, b) => a + b, 0),
	maxDamageDealtToHero: (postMatchStats: BgsPostMatchStats, input: Input): number =>
		Math.max(
			...postMatchStats.damageToEnemyHeroOverTurn
				.filter(info => info.value.enemyHeroCardId !== CardIds.KelthuzadBattlegrounds)
				.map(info => (info.value.value != null ? info.value.value : ((info.value as any) as number))), // For backward compatibility
		),
	highestWinStreak: (postMatchStats: BgsPostMatchStats, input: Input): number => input.mainPlayer?.highestWinStreak,
	triplesCreated: (postMatchStats: BgsPostMatchStats, input: Input): number => input.mainPlayer?.tripleHistory.length,
	maxBoardStats: (postMatchStats: BgsPostMatchStats, input: Input): number =>
		Math.max(...postMatchStats.totalStatsOverTurn.map(stat => stat.value)),
	coinsWasted: (postMatchStats: BgsPostMatchStats, input: Input): number =>
		postMatchStats.coinsWastedOverTurn.map(value => value.value).reduce((a, b) => a + b, 0),
	rerolls: (postMatchStats: BgsPostMatchStats, input: Input): number => {
		const rerolls = postMatchStats.rerollsOverTurn.map(value => value.value).reduce((a, b) => a + b, 0);
		return input.mainPlayer?.cardId === CardIds.InfiniteTokiBattlegrounds
			? rerolls - postMatchStats.mainPlayerHeroPowersOverTurn.map(value => value.value).reduce((a, b) => a + b, 0)
			: rerolls;
	},
	heroPowerUsed: (postMatchStats: BgsPostMatchStats, input: Input): number =>
		postMatchStats.mainPlayerHeroPowersOverTurn.map(value => value.value).reduce((a, b) => a + b, 0),
	freezes: (postMatchStats: BgsPostMatchStats, input: Input): number =>
		postMatchStats.freezesOverTurn.map(value => value.value).reduce((a, b) => a + b, 0),
	minionsBought: (postMatchStats: BgsPostMatchStats, input: Input): number =>
		postMatchStats.minionsBoughtOverTurn.map(value => value.value).reduce((a, b) => a + b, 0),
	minionsSold: (postMatchStats: BgsPostMatchStats, input: Input): number =>
		postMatchStats.minionsSoldOverTurn.map(value => value.value).reduce((a, b) => a + b, 0),
	enemyMinionsKilled: (postMatchStats: BgsPostMatchStats, input: Input): number =>
		postMatchStats.totalEnemyMinionsKilled,
	enemyHeroesKilled: (postMatchStats: BgsPostMatchStats, input: Input): number =>
		postMatchStats.totalEnemyHeroesKilled,
	percentageOfBattlesGoingFirst: (postMatchStats: BgsPostMatchStats, input: Input): number => {
		const battlesGoingFirst = postMatchStats.wentFirstInBattleOverTurn.filter(value => value.value === true).length;
		const battlesGoingSecond = postMatchStats.wentFirstInBattleOverTurn.filter(value => value.value === false)
			.length;
		return (100 * battlesGoingFirst) / (battlesGoingFirst + battlesGoingSecond);
	},
	battleLuck: (postMatchStats: BgsPostMatchStats, input: Input): number => 100 * postMatchStats.luckFactor,
	negativeBattleLuck: (postMatchStats: BgsPostMatchStats, input: Input): number => -100 * postMatchStats.luckFactor,
};

export const buildNewStats = (
	existingStats: readonly BgsBestStat[],
	postMatchStats: BgsPostMatchStats,
	input: Input,
	today: string,
): readonly BgsBestStat[] => {
	return Object.keys(statsConfig)
		.map((statName: StatName) => handleStat(statName, existingStats, postMatchStats, input, today))
		.filter(stat => stat);
};

const handleStat = (
	statName: StatName,
	existingStats: readonly BgsBestStat[],
	postMatchStats: BgsPostMatchStats,
	input: Input,
	today: string,
): BgsBestStat => {
	const extractor = statsConfig[statName];
	const newStatValue: number = extractor(postMatchStats, input);
	const existingStat = existingStats.find(stat => stat.statName === statName);
	const existingStatValue: number = existingStat?.value;
	if (newStatValue && (!existingStatValue || newStatValue > existingStatValue)) {
		const newStat: BgsBestStat = {
			id: existingStat?.id,
			lastUpdateDate: today,
			userId: input.userId,
			reviewId: input.reviewId,
			statName: statName,
			value: newStatValue,
			heroCardId: input.mainPlayer?.cardId,
		};
		return newStat;
	}
	return null;
};

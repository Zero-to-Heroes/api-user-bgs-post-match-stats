import { parseBattlegroundsGame } from '@firestone-hs/hs-replay-xml-parser/dist/public-api';
import { AllCardsService } from '@firestone-hs/reference-data';
import { xml } from './replay.xml';

const doTest = async () => {
	const allCards = new AllCardsService();
	await allCards.initializeCardsDb();
	const replayXml = xml;
	const postMatchStats = parseBattlegroundsGame(replayXml, null, null, null, allCards);
	console.log(postMatchStats?.hpOverTurn);
};

doTest();

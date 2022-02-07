import { parseBattlegroundsGame } from '@firestone-hs/hs-replay-xml-parser/dist/public-api';
import { xml } from './replay.xml';

const doTest = async () => {
	const replayXml = xml;
	const postMatchStats = parseBattlegroundsGame(replayXml, null, null, null);
	console.log(postMatchStats?.boardHistory);
};

doTest();

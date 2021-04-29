import { BgsFaceOff } from '@firestone-hs/hs-replay-xml-parser/dist/lib/model/bgs-face-off';
import { BattleResultHistory, BgsPlayer } from '@firestone-hs/hs-replay-xml-parser/dist/public-api';

export interface Input {
	readonly reviewId: string;
	readonly heroCardId: string;
	readonly userId: string;
	readonly userName: string;
	readonly battleResultHistory: readonly BattleResultHistory[];
	readonly mainPlayer: BgsPlayer;
	readonly oldMmr: number;
	readonly newMmr: number;
	readonly faceOffs: readonly BgsFaceOff[];
}

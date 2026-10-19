/** Публичные константы бренда и среды. Серверные секреты сюда не попадают. */
import { version } from '../../package.json';

export const config = Object.freeze({ ...__PUBLIC_CONFIG__, name: 'Gault', version, tagline: 'Guard your data. Own your keys.' });

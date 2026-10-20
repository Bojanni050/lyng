import pkg from '../../package.json';

pkg.desktopName = pkg.desktopName || (pkg.name ? `${pkg.name}.desktop` : 'Nuntio.desktop');

export default pkg;

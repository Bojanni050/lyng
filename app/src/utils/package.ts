import pkg from '../../package.json';

pkg.desktopName = pkg.desktopName || (pkg.name ? `${pkg.name}.desktop` : 'Lyng.desktop');

export default pkg;

// vite names the HTML after its input (sources.html); the ConfigMap wants index.html.
const fs = require('fs');
fs.renameSync('dist-sources/sources.html', 'dist-sources/index.html');

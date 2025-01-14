const NodeCache = require('node-cache');

// Cache responses for 5 minutes
const routeCache = new NodeCache({ stdTTL: 300 });

module.exports = { routeCache }; 
// Every 15 minutes: a bus whose phone stopped reporting (dead battery, app closed) and never ended its trip is completed after
// three hours without a reading, so it does not show as "on route" all night.
const cron = require('node-cron');
const { closeAbandonedTrips } = require('../services/busTracking');

module.exports = function startBusTripJob() {
  cron.schedule('*/15 * * * *', () => {
    closeAbandonedTrips().catch((err) => console.error('bus trip clean-up failed:', err.message));
  });
};

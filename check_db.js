const mongoose = require('mongoose');
const MONGO_URI = 'mongodb://127.0.0.1:27017/ricemill';

async function check() {
  await mongoose.connect(MONGO_URI);
  const Notification = mongoose.model('Notification', new mongoose.Schema({}), 'notifications');
  const MeterData = mongoose.model('MeterData', new mongoose.Schema({}), 'meterdatas');
  
  const notifCount = await Notification.countDocuments();
  const dataCount = await MeterData.countDocuments();
  
  console.log(`Notifications: ${notifCount}`);
  console.log(`Meter Data points: ${dataCount}`);
  
  if (notifCount > 0) {
    const lastNotif = await Notification.findOne().sort({ timestamp: -1 });
    console.log('Last Notification:', lastNotif);
  }
  
  process.exit(0);
}

check();

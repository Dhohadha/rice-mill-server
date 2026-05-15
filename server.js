require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const mqtt = require('mqtt');
const cors = require('cors');
const cron = require('node-cron');
const http = require('http');
const { Server } = require('socket.io');

const MeterData = require('./models/MeterData');
const DailyUsage = require('./models/DailyUsage');
const UserSettings = require('./models/UserSettings');
const Notification = require('./models/Notification');
const DeviceToken = require('./models/DeviceToken');
const User = require('./models/User');
const CondensedData = require('./models/CondensedData');
const admin = require('firebase-admin');

// Routes
const userRoutes = require('./routes/userRoutes');
const { verifyToken } = require('./middleware/auth');

// Initialize Firebase Admin
try {
  const serviceAccount = require('./service_account_key.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('🔥 Firebase Admin initialized');
} catch (err) {
  console.error('❌ Firebase Admin initialization error:', err.message);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Mount Routes
app.use('/api/users', userRoutes);

// Socket.io Connection Logic
io.on('connection', (socket) => {
  console.log('🔌 New client connected via WebSocket:', socket.id);
  
  // Clients can join rooms based on device IDs they are authorized to view
  socket.on('joinDeviceRoom', (deviceId) => {
    socket.join(deviceId);
    console.log(`Client ${socket.id} joined room: ${deviceId}`);
  });

  socket.on('disconnect', () => {
    console.log('❌ Client disconnected:', socket.id);
  });
});

// MongoDB Connection
// Defaulting to a local MongoDB instance for development
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/ricemill';
mongoose.connect(process.env.MONGODB_URI || MONGO_URI)
  .then(async () => {
    console.log('MongoDB connected');
    try {
      // Cleanup bad records that might break today's consumption logic
      const result = await MeterData.deleteMany({ $or: [{ KWH: 0 }, { KWH: null }, { KWH: { $exists: false } }] });
      if (result.deletedCount > 0) {
        console.log(`🧹 Cleaned up ${result.deletedCount} invalid MeterData records`);
      }
      // Set default PF limit to 0.85 for all users who have the old default (0.90) or haven't set one
      await UserSettings.updateMany(
        { $or: [{ pfLimit: 0.90 }, { pfLimit: { $exists: false } }] }, 
        { $set: { pfLimit: 0.85 } }
      );
    } catch (e) {
      console.log('⚠️  Note: Cleanup or migration failed:', e.message);
    }
  })
  .catch(err => console.error('MongoDB connection error:', err));

// MQTT Setup
const MQTT_BROKER = 'mqtt://broker.emqx.io:1883';
const MQTT_TOPICS = ['EMS1/data', 'EMS/+/data'];
const mqttClient = mqtt.connect(MQTT_BROKER);

mqttClient.on('connect', () => {
  console.log('✅ Connected to MQTT Broker:', MQTT_BROKER);
  mqttClient.subscribe(MQTT_TOPICS, (err) => {
    if (err) console.error('❌ MQTT Subscribe error:', err);
    else console.log('📁 Subscribed to topics:', MQTT_TOPICS);
  });
});

// Throttle control for saving data (per device)
const lastSaveTimes = new Map();
const SAVE_INTERVAL = 60 * 1000; // 1 minute

// Process incoming MQTT messages
mqttClient.on('message', async (topic, message) => {
  console.log(`📩 Received message on [${topic}]:`, message.toString());
  
  let deviceId = null;
  if (topic === 'EMS1/data') {
    deviceId = 'RICE_MILL_001';
  } else if (topic.startsWith('EMS/') && topic.endsWith('/data')) {
    // Pattern: EMS/DEVICE_ID/data
    deviceId = topic.split('/')[1];
  }

  if (deviceId) {
    try {
      const payload = JSON.parse(message.toString());
      if (payload.status === "no_data") return; 
      
      // Map incoming fields to schema fields
      if (payload.KW1 !== undefined) {
        payload.KW_R = payload.KW1;
        payload.KW_Y = payload.KW2;
        payload.KW_B = payload.KW3;
        payload.KW = (payload.KW1 || 0) + (payload.KW2 || 0) + (payload.KW3 || 0);
      }
      if (payload.KVA1 !== undefined) {
        payload.KVA_R = payload.KVA1;
        payload.KVA_Y = payload.KVA2;
        payload.KVA_B = payload.KVA3;
        payload.KVA = (payload.KVA1 || 0) + (payload.KVA2 || 0) + (payload.KVA3 || 0);
      }
      if (payload.PF1 !== undefined) {
        payload.PF_R = payload.PF1;
        payload.PF_Y = payload.PF2;
        payload.PF_B = payload.PF3;
        payload.PF = ((payload.PF1 || 0) + (payload.PF2 || 0) + (payload.PF3 || 0)) / 3;
      }
      if (payload.F !== undefined) {
        payload.Freq = payload.F;
      }

      payload.deviceId = deviceId;

      const now = Date.now();
      const lastSaveTime = lastSaveTimes.get(deviceId) || 0;

      if (now - lastSaveTime >= SAVE_INTERVAL) {
        const newData = new MeterData(payload);
        await newData.save();
        
        // Also save condensed data for long-term analysis (30 days)
        const CondensedData = require('./models/CondensedData');
        await new CondensedData({
          deviceId: payload.deviceId,
          KVA: payload.KVA,
          KW: payload.KW,
          PF: payload.PF,
          KWH: payload.KWH,
          timestamp: now
        }).save();

      lastSaveTimes.set(deviceId, now);
      console.log(`💾 Data saved to MongoDB for ${deviceId}: KW=${payload.KW?.toFixed(2)}, KVA=${payload.KVA?.toFixed(2)}, PF=${payload.PF?.toFixed(3)}, KWH=${payload.KWH}`);
    }

    // Emit data over WebSockets to specific device room
    io.to(payload.deviceId).emit('meterData', payload);

      // Alert Check (Per User)
      const User = require('./models/User');
      const usersWithAccess = await User.find({ assignedDevices: payload.deviceId });
      
      for (const user of usersWithAccess) {
        let settings = await UserSettings.findOne({ userEmail: user.email });
        if (!settings) {
          settings = new UserSettings({ userEmail: user.email });
          await settings.save();
        }

        const alerts = [];
        if (payload.KVA && payload.KVA > settings.cmdLimit) {
          alerts.push({ type: 'CMD', msg: `CMD Alert: Current kVA (${payload.KVA}) exceeded limit (${settings.cmdLimit})!`});
        }
        if (payload.KW && payload.KW > settings.powerLimit) {
          alerts.push({ type: 'POWER', msg: `POWER Alert: Current kW (${payload.KW}) exceeded limit (${settings.powerLimit})!`});
        }
        if (payload.PF && payload.PF < settings.pfLimit) {
          alerts.push({ type: 'PF', msg: `PF Alert: Current PF (${payload.PF}) fell below limit (${settings.pfLimit})!`});
        }

        for (let alert of alerts) {
          // Prevent spamming the same user with the same alert type within 5 minutes
          const recentAlert = await Notification.findOne({
            type: alert.type,
            userEmail: user.email, // We should add userEmail to Notification model too
            timestamp: { $gte: new Date(Date.now() - 5 * 60 * 1000) }
          });
          
          if (!recentAlert) {
            await new Notification({ 
              deviceId: payload.deviceId,
              title: `Limit Exceeded`, 
              message: alert.msg, 
              type: alert.type,
              userEmail: user.email 
            }).save();
            
            // Send FCM push notifications to THIS user specifically
            try {
              const tokens = await DeviceToken.find({ userEmail: user.email });
              const registrationTokens = tokens.map(t => t.token);

              if (registrationTokens.length > 0) {
                const message = {
                  data: {
                    title: `⚠️ Alert: ${payload.deviceId}`,
                    body: alert.msg,
                    alertId: `ALERT_${Date.now()}`,
                    deviceId: payload.deviceId,
                  },
                  tokens: registrationTokens,
                  android: {
                    priority: 'high',
                  },
                };

                const response = await admin.messaging().sendEachForMulticast(message);
                console.log(`📲 Successfully sent ${response.successCount} push notifications to ${user.email}`);
                
                // Cleanup invalid tokens
                if (response.failureCount > 0) {
                  const failedTokens = [];
                  response.responses.forEach((resp, idx) => {
                    if (!resp.success) failedTokens.push(registrationTokens[idx]);
                  });
                  if (failedTokens.length > 0) {
                    await DeviceToken.deleteMany({ token: { $in: failedTokens } });
                  }
                }
              }
            } catch (fcmErr) {
              console.error(`❌ FCM Send Error for ${user.email}:`, fcmErr.message);
            }
          }
        }
      }

    } catch (err) {
      console.error("❌ Error processing MQTT message:", err.message);
    }
  }
});

// Daily Cron Job (Midnight) to calculate total kWh consumed per device
cron.schedule('0 0 * * *', async () => {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Get all unique device IDs from MeterData
    const deviceIds = await MeterData.distinct('deviceId');
    console.log(`⏰ Running midnight cron for ${deviceIds.length} devices...`);

    for (const deviceId of deviceIds) {
      // Find min and max KWH for the day for THIS device
      const minRec = await MeterData.findOne({ deviceId, timestamp: { $gte: yesterday, $lt: todayStart } }).sort({ KWH: 1 });
      const maxRec = await MeterData.findOne({ deviceId, timestamp: { $gte: yesterday, $lt: todayStart } }).sort({ KWH: -1 });

      if (minRec && maxRec) {
        let consumedKWh = maxRec.KWH - minRec.KWH;
        if (consumedKWh < 0) consumedKWh = maxRec.KWH; // Handle reset

        await DailyUsage.updateOne(
          { date: yesterday, deviceId },
          { totalKWh: consumedKWh },
          { upsert: true }
        );
        console.log(`✅ Daily usage [${deviceId}] for ${yesterday.toDateString()}: ${consumedKWh.toFixed(2)} kWh`);
      }
    }
  } catch (err) {
    console.error('Error in cron job:', err);
  }
});


// Get latest meter status
app.get('/api/status', async (req, res) => {
  try {
    const { deviceId } = req.query;
    const query = deviceId ? { deviceId } : {};
    const latest = await MeterData.findOne(query).sort({ timestamp: -1 });
    if (!latest) return res.status(404).json({ error: 'No data found' });
    res.json(latest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= APIs =================

// History Data for Graph (Hour/Day breakdown)
app.get('/api/history', async (req, res) => {
  try {
    const { range } = req.query; // 'hour' or 'day'
    const now = new Date();
    const startDate = new Date();
    
    if (range === 'hour') {
      startDate.setHours(now.getHours() - 1);
    } else {
      // Default to day (last 24 hours)
      startDate.setHours(now.getHours() - 24);
    }

    console.log(`📊 Fetching history for range: ${range}`);
    const { deviceId } = req.query;
    const query = { timestamp: { $gte: startDate } };
    if (deviceId) query.deviceId = deviceId;
    
    const data = await MeterData.find(query).sort({ timestamp: 1 });
    console.log(`📈 Found ${data.length} history records`);
    // In production, we might want to group this data instead of returning all raw points.
    // However, since readings are every 10s, an hour is ~360 points (fine for chart).
    // A day is ~8640 points (might need downsampling, doing simple skip for now)
    
    let chartData = data;
    if (range !== 'hour' && data.length > 200) {
      const step = Math.floor(data.length / 200);
      chartData = data.filter((_, i) => i % step === 0);
    }

    res.json(chartData.map(d => ({ 
      timestamp: d.timestamp, 
      KWH: d.KWH, 
      KVA: d.KVA, 
      KW: d.KW 
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get User Settings
app.get('/api/settings', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    let settings = await UserSettings.findOne({ userEmail });
    if (!settings) {
      settings = new UserSettings({ userEmail });
      await settings.save();
    }
    console.log(`⚙️ Settings fetched for ${userEmail}`);
    res.json(settings);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Update User Settings
app.post('/api/settings', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const { cmdLimit, cmdMaxGauge, powerLimit, powerMaxGauge, pfLimit } = req.body;
    const updates = {};
    if (cmdLimit !== undefined) updates.cmdLimit = cmdLimit;
    if (cmdMaxGauge !== undefined) updates.cmdMaxGauge = cmdMaxGauge;
    if (powerLimit !== undefined) updates.powerLimit = powerLimit;
    if (powerMaxGauge !== undefined) updates.powerMaxGauge = powerMaxGauge;
    if (pfLimit !== undefined) updates.pfLimit = pfLimit;

    const settings = await UserSettings.findOneAndUpdate(
      { userEmail },
      { $set: updates },
      { returnDocument: 'after', upsert: true }
    );
    console.log(`✅ Settings updated for ${userEmail}:`, updates);
    res.json(settings);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Get Notification History
app.get('/api/notifications', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const latest = await Notification.find({ userEmail }).sort({ timestamp: -1 }).limit(100);
    res.json(latest);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Clear Notifications
app.delete('/api/notifications', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    await Notification.deleteMany({ userEmail });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Delete Single Notification
app.delete('/api/notifications/:id', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    await Notification.findOneAndDelete({ _id: req.params.id, userEmail });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Register FCM Token
app.post('/api/fcm-token', verifyToken, async (req, res) => {
  try {
    const { token } = req.body;
    const userEmail = req.user.email;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    await DeviceToken.findOneAndUpdate(
      { token },
      { userEmail, lastUpdated: Date.now() },
      { upsert: true }
    );
    console.log(`✅ FCM Token registered/updated for ${userEmail}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop Alert API
app.post('/api/stop-alert', async (req, res) => {
  try {
    const { alertId } = req.body;
    console.log(`🔕 Alert stopped by user: ${alertId}`);

    // Here you could also:
    // 1. Update alert status in DB
    // 2. Stop a physical siren via MQTT
    // 3. Emit a socket event to other users

    res.json({ success: true, message: 'Alert stopped signal received' });
  } catch (err) {
    console.error('❌ Stop alert error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test Notification Route
app.post('/api/test-notification', async (req, res) => {
  try {
    const { token, title, message } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const payload = {
      data: {
        title: title || 'Test Notification',
        body: message || 'This is a test notification from the server',
        alertId: `TEST_${Date.now()}`,
      },
      token: token,
      android: {
        priority: 'high',
      },
    };

    const response = await admin.messaging().send(payload);
    console.log('✅ Test notification sent successfully:', response);
    res.json({ success: true, messageId: response });
  } catch (err) {
    console.error('❌ Test notification error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get Daily Usage for total calculation (multi-device support)
app.get('/api/daily-usage', async (req, res) => {
  try {
    const { fromDate, deviceId } = req.query; 
    if (!fromDate || !deviceId) return res.status(400).json({ error: 'fromDate and deviceId are required' });

    const start = new Date(fromDate);
    start.setHours(0,0,0,0);
    
    // 1. Get archived totals from start date (excluding today)
    const usages = await DailyUsage.find({ 
      deviceId, 
      date: { $gte: start } 
    }).lean();
    
    const archivedTotal = usages.reduce((sum, u) => sum + (u.totalKWh || 0), 0);

    // 2. Get live total for today
    const liveToday = await calculateTodayConsumption(deviceId);

    res.json({ totalKWhConsumed: archivedTotal + liveToday });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Helper to calculate live today usage
async function calculateTodayConsumption(deviceId) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // 1. Get the current latest reading
  const currentNow = await MeterData.findOne({ deviceId }).sort({ timestamp: -1 }).lean();
  if (!currentNow || !currentNow.KWH) {
    console.log(`📊 No current KWH reading found for ${deviceId}`);
    return 0;
  }

  // 2. Get the baseline (last reading BEFORE today with a valid KWH > 0)
  let baseline = await MeterData.findOne({ 
    deviceId, 
    timestamp: { $lt: todayStart },
    KWH: { $gt: 0 }
  }).sort({ timestamp: -1 }).lean();

  // 3. Fallback: Earliest record from today with a valid KWH > 0
  if (!baseline) {
    baseline = await MeterData.findOne({ 
      deviceId, 
      timestamp: { $gte: todayStart },
      KWH: { $gt: 0 }
    }).sort({ timestamp: 1 }).lean();
  }

  let todayConsumption = 0;
  if (baseline && baseline.KWH && currentNow && currentNow.KWH) {
    if (currentNow.KWH >= baseline.KWH) {
      todayConsumption = currentNow.KWH - baseline.KWH;
    } else {
      // Rollover: Meter reset or wrapped around
      todayConsumption = currentNow.KWH;
    }
    console.log(`📊 Today Consumption for ${deviceId}: ${todayConsumption.toFixed(2)} kWh (Baseline: ${baseline.KWH}, Current: ${currentNow.KWH})`);
  } else {
    console.log(`📊 Baseline not found or invalid for ${deviceId}. Baseline: ${JSON.stringify(baseline)}`);
    // If no baseline at all, today's consumption is 0 until we get a second reading
    todayConsumption = 0;
  }
  
  return todayConsumption;
}

// Get Today's Consumption (Midnight to Now)
app.get('/api/today-usage', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const todayConsumption = await calculateTodayConsumption(deviceId);
    res.json({ todayKWh: todayConsumption });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= Analysis APIs =================

// 1. Get 7-Day KWH Usage
app.get('/api/analysis/7day-usage', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const results = [];
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    // We want the last 7 days ending with today
    for (let i = 6; i >= 0; i--) {
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() - i);
      targetDate.setHours(0, 0, 0, 0);

      let kwh = 0;
      if (i === 0) {
        // Today is live
        kwh = await calculateTodayConsumption(deviceId);
      } else {
        // Historical
        const record = await DailyUsage.findOne({ deviceId, date: targetDate });
        kwh = record ? record.totalKWh : 0;
      }

      results.push({
        label: days[targetDate.getDay()],
        fullDate: targetDate,
        kwh: kwh
      });
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Get Period Max/Min Stats (KVA, KWH)
app.get('/api/analysis/period-stats', async (req, res) => {
  try {
    const { deviceId, fromDate } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
    
    const start = fromDate ? new Date(fromDate) : new Date();
    if (!fromDate) start.setHours(0, 0, 0, 0);

    let stats = await CondensedData.aggregate([
      { $match: { deviceId, timestamp: { $gte: start } } },
      { $group: {
        _id: null,
        avgPF: { $sum: "$PF" },
        count: { $sum: 1 }
      }}
    ]);

    // Fallback for avgPF if CondensedData is empty (common for today)
    if (stats.length === 0) {
      stats = await MeterData.aggregate([
        { $match: { deviceId, timestamp: { $gte: start } } },
        { $group: {
          _id: null,
          avgPF: { $sum: "$PF" },
          count: { $sum: 1 }
        }}
      ]);
    }

    const avgPF = (stats.length > 0 && stats[0].count > 0) ? (stats[0].avgPF / stats[0].count) : 0;

    // Helper to query either CondensedData or MeterData (fallback)
    async function getExtreme(field, sortOrder, excludeZero = false) {
      let query = { deviceId, timestamp: { $gte: start } };
      if (excludeZero) query[field] = { $gt: 0 };

      // 1. Try CondensedData first
      let record = await CondensedData.findOne(query).sort({ [field]: sortOrder }).lean();
      
      // 2. Fallback to MeterData if CondensedData has no records (common for "today")
      if (!record) {
        record = await MeterData.findOne(query).sort({ [field]: sortOrder }).lean();
      }
      return record;
    }

    const maxKVA = await getExtreme('KVA', -1);
    const minKVA = await getExtreme('KVA', 1, true);
    const maxKWH = await getExtreme('KWH', -1);
    const minKWH = await getExtreme('KWH', 1, true);
    const maxKW = await getExtreme('KW', -1);
    const minKW = await getExtreme('KW', 1, true);

    res.json({
      kva: {
        max: maxKVA ? maxKVA.KVA : 0,
        maxTime: maxKVA ? maxKVA.timestamp : null,
        min: minKVA ? minKVA.KVA : 0,
        minTime: minKVA ? minKVA.timestamp : null,
      },
      kw: {
        max: maxKW ? maxKW.KW : 0,
        maxTime: maxKW ? maxKW.timestamp : null,
        min: minKW ? minKW.KW : 0,
        minTime: minKW ? minKW.timestamp : null,
      },
      kwh: {
        max: maxKWH ? maxKWH.KWH : 0,
        maxTime: maxKWH ? maxKWH.timestamp : null,
        min: minKWH ? minKWH.KWH : 0,
        minTime: minKWH ? minKWH.timestamp : null,
      },
      avgPF: avgPF
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Get Today's Max/Min Stats (KVA, KW, KWH)
app.get('/api/analysis/today-stats', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const CondensedData = require('./models/CondensedData');
    const stats = await CondensedData.aggregate([
      { $match: { deviceId, timestamp: { $gte: todayStart } } },
      { $group: {
        _id: null,
        maxKVA: { $max: "$KVA" },
        minKVA: { $min: "$KVA" },
        maxKW: { $max: "$KW" },
        minKW: { $min: "$KW" },
        startKWH: { $min: "$KWH" },
        endKWH: { $max: "$KWH" },
        avgPF: { $avg: "$PF" }
      }}
    ]);

    if (stats.length === 0) return res.status(404).json({ error: 'No data for today yet' });

    const s = stats[0];
    res.json({
      kva: { max: s.maxKVA || 0, min: s.minKVA || 0 },
      kw: { max: s.maxKW || 0, min: s.minKW || 0 },
      kwh: { start: s.startKWH || 0, end: s.endKWH || 0, consumed: (s.endKWH || 0) - (s.startKWH || 0) },
      pf: { avg: s.avgPF || 0 }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get Mixed Stats for multiple devices
app.get('/api/analysis/mixed-stats', async (req, res) => {
  try {
    let { deviceIds, fromDate } = req.query;
    if (!deviceIds) return res.status(400).json({ error: 'deviceIds are required' });
    
    // Ensure deviceIds is an array
    if (!Array.isArray(deviceIds)) deviceIds = [deviceIds];

    const start = fromDate ? new Date(fromDate) : new Date();
    if (!fromDate) start.setHours(0, 0, 0, 0);

    // 1. Calculate Total Consumed KWH (Live + Archived) for all devices
    let totalConsumed = 0;
    for (const dId of deviceIds) {
      // Archived
      const usages = await DailyUsage.find({ deviceId: dId, date: { $gte: start } }).lean();
      totalConsumed += usages.reduce((sum, u) => sum + (u.totalKWh || 0), 0);
      // Live Today
      totalConsumed += await calculateTodayConsumption(dId);
    }

    // 2. Aggregate Avg PF across all devices
    let pfStats = await CondensedData.aggregate([
      { $match: { deviceId: { $in: deviceIds }, timestamp: { $gte: start } } },
      { $group: { _id: null, avgPF: { $sum: "$PF" }, count: { $sum: 1 } } }
    ]);
    if (pfStats.length === 0) {
      pfStats = await MeterData.aggregate([
        { $match: { deviceId: { $in: deviceIds }, timestamp: { $gte: start } } },
        { $group: { _id: null, avgPF: { $sum: "$PF" }, count: { $sum: 1 } } }
      ]);
    }
    const avgPF = (pfStats.length > 0 && pfStats[0].count > 0) ? (pfStats[0].avgPF / pfStats[0].count) : 0;

    // 3. Find Global Extremes
    async function getGlobalExtreme(field, sortOrder, excludeZero = false) {
      let query = { deviceId: { $in: deviceIds }, timestamp: { $gte: start } };
      if (excludeZero) query[field] = { $gt: 0 };
      let record = await CondensedData.findOne(query).sort({ [field]: sortOrder }).lean();
      if (!record) record = await MeterData.findOne(query).sort({ [field]: sortOrder }).lean();
      return record;
    }

    const maxKVA = await getGlobalExtreme('KVA', -1);
    const minKVA = await getGlobalExtreme('KVA', 1, true);
    const maxKW = await getGlobalExtreme('KW', -1);
    const minKW = await getGlobalExtreme('KW', 1, true);

    res.json({
      totalConsumedKWh: totalConsumed,
      avgPF: avgPF,
      kva: {
        max: maxKVA ? maxKVA.KVA : 0,
        maxTime: maxKVA ? maxKVA.timestamp : null,
        min: minKVA ? minKVA.KVA : 0,
        minTime: minKVA ? minKVA.timestamp : null,
      },
      kw: {
        max: maxKW ? maxKW.KW : 0,
        maxTime: maxKW ? maxKW.timestamp : null,
        min: minKW ? minKW.KW : 0,
        minTime: minKW ? minKW.timestamp : null,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/profile', verifyToken, async (req, res) => {
  try {
    const User = require('./models/User');
    const user = await User.findOne({ email: req.user.email.toLowerCase() });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Rice Mill Server v2.1 (EMS1) listening on port ${PORT}`);
});

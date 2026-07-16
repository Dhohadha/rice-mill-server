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

// Root Health Check
app.get('/', (req, res) => res.json({ status: 'ok', message: 'Rice Mill Server is running' }));

// Socket.io Connection Logic
io.on('connection', (socket) => {
  // console.log('🔌 New client connected via WebSocket:', socket.id);
  
  // Clients can join rooms based on device IDs they are authorized to view
  socket.on('joinDeviceRoom', (deviceId) => {
    socket.join(deviceId);
    // console.log(`Client ${socket.id} joined room: ${deviceId}`);
  });

  socket.on('disconnect', () => {
    // console.log('❌ Client disconnected:', socket.id);
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

      // Self-heal: Trim assignedDevices for all users to prevent trailing space issues
      const User = require('./models/User');
      const allUsers = await User.find({});
      for (const u of allUsers) {
        if (u.assignedDevices && u.assignedDevices.length > 0) {
          const trimmedDevices = u.assignedDevices.map(d => d.trim()).filter(d => d.length > 0);
          const isChanged = JSON.stringify(u.assignedDevices) !== JSON.stringify(trimmedDevices);
          if (isChanged) {
            u.assignedDevices = trimmedDevices;
            await u.save();
            console.log(`✅ [Self-Heal] Trimmed assignedDevices for user ${u.email}:`, trimmedDevices);
          }
        }
      }
    } catch (e) {
      console.log('⚠️  Note: Cleanup or migration failed:', e.message);
    }
  })
  .catch(err => console.error('MongoDB connection error:', err));

// MQTT Setup
const MQTT_BROKER = 'mqtt://broker.emqx.io:1883';
const MQTT_TOPICS = ['EMS1/data', 'EMS/+/data', 'APFC1/data'];
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
const SAVE_INTERVAL = 60 * 700; // 1 minute

// Consecutive breach counters to prevent transient spikes
// Key structure: `${userEmail}_${deviceId}_${alertType}`
const consecutiveBreachCounts = {};

// Process incoming MQTT messages
mqttClient.on('message', async (topic, message) => {
  // console.log(`📩 Received message on [${topic}]:`, message.toString());
  
  let deviceId = null;
  if (topic === 'EMS1/data') {
    deviceId = 'RICE_MILL_001';
  } else if (topic === 'APFC1/data') {
    deviceId = 'APFC_001';
  } else if (topic.startsWith('EMS/') && topic.endsWith('/data')) {
    // Pattern: EMS/DEVICE_ID/data
    deviceId = topic.split('/')[1];
  }

  if (deviceId) {
    try {
      const payload = JSON.parse(message.toString());
      if (payload.status === "no_data") return; 
      
      // Map incoming fields to schema fields (New Format Support)
      if (payload.TotalKW !== undefined) {
        payload.KW = payload.TotalKW / 1000;
      }
      if (payload.TotalKVA !== undefined) {
        payload.KVA = payload.TotalKVA / 1000;
      }
      if (payload.TotalKVAR !== undefined) {
        payload.KVAR = payload.TotalKVAR / 1000;
      }
      if (payload.TotalPF !== undefined) {
        payload.PF = payload.TotalPF;
      }
      if (payload.ImportWh !== undefined) {
        payload.KWH = payload.ImportWh;
      }
      if (payload.ImportVAh !== undefined) {
        payload.KVAH = payload.ImportVAh;
      }

      // Map incoming fields to schema fields (Old Format Support)
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
        lastSaveTimes.set(deviceId, now);
        // console.log(`💾 Data saved to MongoDB for ${deviceId}: KW=${payload.KW?.toFixed(2)}, KVA=${payload.KVA?.toFixed(2)}, PF=${payload.PF?.toFixed(3)}, KWH=${payload.KWH}`);
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

        const alertsToCheck = [
          {
            type: 'CMD',
            isBreached: payload.KVA && payload.KVA > settings.cmdLimit,
            msg: `CMD Alert: Current kVA (${payload.KVA}) exceeded limit (${settings.cmdLimit})!`
          },
          {
            type: 'POWER',
            isBreached: payload.KW && payload.KW > settings.powerLimit,
            msg: `POWER Alert: Current kW (${payload.KW}) exceeded limit (${settings.powerLimit})!`
          },
          {
            type: 'PF',
            isBreached: payload.PF && payload.PF < settings.pfLimit,
            msg: `PF Alert: Current PF (${payload.PF}) fell below limit (${settings.pfLimit})!`
          }
        ];

        const alerts = [];

        for (const alertCheck of alertsToCheck) {
          const key = `${user.email}_${payload.deviceId}_${alertCheck.type}`;
          
          if (alertCheck.isBreached) {
            consecutiveBreachCounts[key] = (consecutiveBreachCounts[key] || 0) + 1;
            // console.log(`⚠️  [Alert Check] ${key} - consecutive breaches: ${consecutiveBreachCounts[key]}/7`);
            
            // Trigger alert on exactly the 7th consecutive breach and reset counter
            if (consecutiveBreachCounts[key] === 7) {
              alerts.push({ type: alertCheck.type, msg: alertCheck.msg });
              consecutiveBreachCounts[key] = 0;
            }
          } else {
            // Reset counter when value is back in the normal range
            if (consecutiveBreachCounts[key] > 0) {
              // console.log(`✅ [Alert Recovered] ${key} - reset breach counter to 0`);
              consecutiveBreachCounts[key] = 0;
            }
          }
        }

        for (let alert of alerts) {
          // Prevent spamming the same user with the same alert type within 5 minutes
          const recentAlert = await Notification.findOne({
            type: alert.type,
            userEmail: user.email, // We should add userEmail to Notification model too
            timestamp: { $gte: new Date(Date.now() - 5 * 60 * 700) }
          });
          
          if (!recentAlert) {
            await new Notification({ 
              deviceId: payload.deviceId,
              title: `Limit Exceeded`, 
              message: alert.msg, 
              type: alert.type,
              userEmail: user.email.toLowerCase() 
            }).save();
            
            // Send FCM push notifications to THIS user specifically
            try {
              const normalizedEmail = user.email.toLowerCase();
              const tokens = await DeviceToken.find({ userEmail: normalizedEmail });
              const registrationTokens = tokens.map(t => t.token);

              if (registrationTokens.length > 0) {
                const message = {
                  data: {
                    title: `⚠️ Alert: ${payload.deviceId}`,
                    body: alert.msg,
                    alertId: alert.type === 'PF' ? 'PF' : `ALERT_${Date.now()}`,
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

    const deviceIds = await MeterData.distinct('deviceId');
    console.log(`⏰ Running midnight cron for ${deviceIds.length} devices...`);

    for (const deviceId of deviceIds) {
      // 1. Consumption calculation
      const minRec = await MeterData.findOne({ 
        deviceId, 
        timestamp: { $gte: yesterday, $lt: todayStart }, 
        KWH: { $gt: 0 } 
      }).sort({ KWH: 1 });
      
      const maxRec = await MeterData.findOne({ 
        deviceId, 
        timestamp: { $gte: yesterday, $lt: todayStart } 
      }).sort({ KWH: -1 });

      if (minRec && maxRec) {
        let consumedKWh = maxRec.KWH - minRec.KWH;
        if (consumedKWh < 0) consumedKWh = maxRec.KWH; // Handle reset

        // 2. Aggregate Max/Min/Avg
        const stats = await MeterData.aggregate([
          { $match: { deviceId, timestamp: { $gte: yesterday, $lt: todayStart } } },
          { $group: {
            _id: null,
            avgPF: { $avg: "$PF" }
          }}
        ]);

        const getDayExtreme = async (field, sortOrder, excludeZero = false) => {
          let query = { deviceId, timestamp: { $gte: yesterday, $lt: todayStart } };
          if (excludeZero) query[field] = { $gt: 0 };
          return await MeterData.findOne(query).sort({ [field]: sortOrder }).lean();
        };

        const maxKVA = await getDayExtreme('KVA', -1);
        const minKVA = await getDayExtreme('KVA', 1, true);
        const maxKW = await getDayExtreme('KW', -1);
        const minKW = await getDayExtreme('KW', 1, true);

        await DailyUsage.updateOne(
          { date: yesterday, deviceId },
          { 
            totalKWh: consumedKWh,
            maxKVA: maxKVA ? maxKVA.KVA : 0,
            maxKVATime: maxKVA ? maxKVA.timestamp : null,
            minKVA: minKVA ? minKVA.KVA : 0,
            minKVATime: minKVA ? minKVA.timestamp : null,
            maxKW: maxKW ? maxKW.KW : 0,
            maxKWTime: maxKW ? maxKW.timestamp : null,
            minKW: minKW ? minKW.KW : 0,
            minKWTime: minKW ? minKW.timestamp : null,
            avgPF: (stats.length > 0) ? (stats[0].avgPF || 0) : 0
          },
          { upsert: true }
        );
        console.log(`✅ Daily summary [${deviceId}] for ${yesterday.toDateString()} saved.`);
      }
    }

    // 3. Cleanup: Delete data older than 2 days
    const cleanupDate = new Date();
    cleanupDate.setDate(cleanupDate.getDate() - 2);
    const resultMeter = await MeterData.deleteMany({ timestamp: { $lt: cleanupDate } });
    const resultCond = await CondensedData.deleteMany({ timestamp: { $lt: cleanupDate } });
    console.log(`🧹 Cleanup: Removed ${resultMeter.deletedCount} MeterData and ${resultCond.deletedCount} CondensedData records.`);

  } catch (err) {
    console.error('Error in cron job:', err);
  }
});

// Helper to calculate historical day stats on-the-fly (fallback for missing DailyUsage)
async function calculateHistoricalDayStats(deviceId, date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  // console.log(`🔍 Calculating on-the-fly stats for ${deviceId} on ${start.toDateString()}...`);

  // 1. Basic Aggregation (Avg PF, Max/Min Values)
  const stats = await MeterData.aggregate([
    { $match: { deviceId, timestamp: { $gte: start, $lte: end } } },
    { $group: {
      _id: null,
      avgPF: { $avg: "$PF" },
      maxKVA: { $max: "$KVA" },
      minKVA: { $min: { $cond: [{ $gt: ["$KVA", 0] }, "$KVA", 700000] } },
      maxKW: { $max: "$KW" },
      minKW: { $min: { $cond: [{ $gt: ["$KW", 0] }, "$KW", 700000] } },
    }}
  ]);

  if (stats.length === 0) {
    // console.log(`⚠️ No MeterData found for ${deviceId} on ${start.toDateString()}`);
    return null;
  }

  const s = stats[0];
  if (s.minKVA === 700000) s.minKVA = 0;
  if (s.minKW === 700000) s.minKW = 0;

  // 2. Exact Timestamps for Extremes
  const getExtreme = async (field, sortOrder) => {
    return await MeterData.findOne({ deviceId, timestamp: { $gte: start, $lte: end }, [field]: { $gt: 0 } })
      .sort({ [field]: sortOrder })
      .lean();
  };

  const maxKVARec = await getExtreme('KVA', -1);
  const minKVARec = await getExtreme('KVA', 1);
  const maxKWRec = await getExtreme('KW', -1);
  const minKWRec = await getExtreme('KW', 1);

  // 3. Consumption (KWH Delta)
  const minKwh = await MeterData.findOne({ deviceId, timestamp: { $gte: start, $lte: end }, KWH: { $gt: 0 } })
    .sort({ KWH: 1 })
    .lean();
  const maxKwh = await MeterData.findOne({ deviceId, timestamp: { $gte: start, $lte: end } })
    .sort({ KWH: -1 })
    .lean();
  
  let consumption = 0;
  if (minKwh && maxKwh) {
    consumption = maxKwh.KWH - minKwh.KWH;
    if (consumption < 0) consumption = maxKwh.KWH;
  }

  return {
    totalKWh: consumption,
    maxKVA: s.maxKVA || 0,
    maxKVATime: maxKVARec ? maxKVARec.timestamp : null,
    minKVA: s.minKVA || 0,
    minKVATime: minKVARec ? minKVARec.timestamp : null,
    maxKW: s.maxKW || 0,
    maxKWTime: maxKWRec ? maxKWRec.timestamp : null,
    minKW: s.minKW || 0,
    minKWTime: minKWRec ? minKWRec.timestamp : null,
    avgPF: s.avgPF || 0,
    date: start
  };
}


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

    // console.log(`📊 Fetching history for range: ${range}`);
    const { deviceId } = req.query;
    const query = { timestamp: { $gte: startDate } };
    if (deviceId) query.deviceId = deviceId;
    
    const data = await MeterData.find(query).sort({ timestamp: 1 });
    // console.log(`📈 Found ${data.length} history records`);
    // In production, we might want to group this data instead of returning all raw points.
    // However, since readings are every 7s, an hour is ~360 points (fine for chart).
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
    // console.log(`⚙️ Settings fetched for ${userEmail}`);
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
    // console.log(`✅ Settings updated for ${userEmail}:`, updates);
    res.json(settings);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Get Notification History
app.get('/api/notifications', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const latest = await Notification.find({ userEmail }).sort({ timestamp: -1 }).limit(70);
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
    const userEmail = req.user.email.toLowerCase();
    if (!token) return res.status(400).json({ error: 'Token is required' });

    await DeviceToken.findOneAndUpdate(
      { token },
      { userEmail, lastUpdated: Date.now() },
      { upsert: true }
    );
    // console.log(`✅ FCM Token registered/updated for ${userEmail}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop Alert API
app.post('/api/stop-alert', async (req, res) => {
  try {
    const { alertId } = req.body;
    // console.log(`🔕 Alert stopped by user: ${alertId}`);

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
    // console.log(`📊 No current KWH reading found for ${deviceId}`);
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
    // console.log(`📊 Today Consumption for ${deviceId}: ${todayConsumption.toFixed(2)} kWh (Baseline: ${baseline.KWH}, Current: ${currentNow.KWH})`);
  } else {
    // console.log(`📊 Baseline not found or invalid for ${deviceId}. Baseline: ${JSON.stringify(baseline)}`);
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

// 1. Get Historical KWH Usage (up to 50 days)
app.get('/api/analysis/historical-usage', async (req, res) => {
  try {
    const { deviceId, days: daysCount = 7 } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const limit = Math.min(parseInt(daysCount), 60); // Cap at 60 days
    const results = [];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    for (let i = limit - 1; i >= 0; i--) {
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
        if (record) {
          kwh = record.totalKWh;
        } else {
          // Fallback: If summary is missing but data is recent (within 2 days), calculate it
          const fallback = await calculateHistoricalDayStats(deviceId, targetDate);
          kwh = fallback ? fallback.totalKWh : 0;
        }
      }

      // Only include day if data was recorded (kwh > 0) OR if it's Today (i === 0)
      if (kwh > 0 || i === 0) {
        results.push({
          label: dayNames[targetDate.getDay()],
          fullDate: targetDate,
          kwh: kwh
        });
      }
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Get Period Max/Min Stats (KVA, KW, PF)
app.get('/api/analysis/period-stats', async (req, res) => {
  try {
    const { deviceId, fromDate, toDate } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
    
    const start = fromDate ? new Date(fromDate) : new Date();
    if (!fromDate) start.setHours(0, 0, 0, 0);
    const end = toDate ? new Date(toDate) : new Date();

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // 1. Get History from DailyUsage (up to yesterday)
    let historicalUsages = await DailyUsage.find({
      deviceId,
      date: { $gte: start, $lt: todayStart }
    }).lean();

    // 1.1 Fallback logic: If we are looking for a specific day (like yesterday) 
    // and it's missing from DailyUsage, calculate it from raw data.
    if (historicalUsages.length === 0 && start < todayStart) {
      // Calculate how many days we are looking for
      const dayDiff = Math.ceil((todayStart - start) / (700 * 60 * 60 * 24));
      
      // If it's a small range (last 2 days), we can afford to calculate it live
      if (dayDiff <= 2) {
        const fallbackData = [];
        for (let i = 0; i < dayDiff; i++) {
          const d = new Date(start);
          d.setDate(d.getDate() + i);
          const stats = await calculateHistoricalDayStats(deviceId, d);
          if (stats) fallbackData.push(stats);
        }
        historicalUsages = fallbackData;
      }
    }

    // 2. Get Live Today from MeterData
    let todayStats = null;
    if (end >= todayStart) {
      const stats = await MeterData.aggregate([
        { $match: { deviceId, timestamp: { $gte: todayStart, $lte: end } } },
        { $group: {
          _id: null,
          avgPF: { $avg: "$PF" },
          maxKVA: { $max: "$KVA" },
          minKVA: { $min: { $cond: [{ $gt: ["$KVA", 0] }, "$KVA", 700000] } }, // Use large fallback for min
          maxKW: { $max: "$KW" },
          minKW: { $min: { $cond: [{ $gt: ["$KW", 0] }, "$KW", 700000] } },
        }}
      ]);
      if (stats.length > 0) {
        todayStats = stats[0];
        // Correct min values if no data > 0 was found
        if (todayStats.minKVA === 700000) todayStats.minKVA = 0;
        if (todayStats.minKW === 700000) todayStats.minKW = 0;
        
        // For today's extreme times, we need a separate query since aggregate doesn't return which record had the max
        const getLiveExtreme = async (field, sortOrder) => {
          return await MeterData.findOne({ deviceId, timestamp: { $gte: todayStart, $lte: end }, [field]: { $gt: 0 } }).sort({ [field]: sortOrder }).lean();
        };
        todayStats.maxKVARec = await getLiveExtreme('KVA', -1);
        todayStats.minKVARec = await getLiveExtreme('KVA', 1);
        todayStats.maxKWRec = await getLiveExtreme('KW', -1);
        todayStats.minKWRec = await getLiveExtreme('KW', 1);
      }
    }

    // Combine Historical and Today
    const findGlobalMax = (hField, hTimeField, tVal, tTime) => {
      let maxVal = tVal || 0;
      let maxTime = tTime || null;
      for (const u of historicalUsages) {
        if ((u[hField] || 0) >= maxVal) {
          maxVal = u[hField];
          maxTime = u[hTimeField];
        }
      }
      return { val: maxVal, time: maxTime };
    };

    const findGlobalMin = (hField, hTimeField, tVal, tTime) => {
      let minVal = (tVal && tVal > 0) ? tVal : null;
      let minTime = tTime || null;
      for (const u of historicalUsages) {
        if (u[hField] > 0 && (minVal === null || u[hField] <= minVal)) {
          minVal = u[hField];
          minTime = u[hTimeField];
        }
      }
      return { val: minVal || 0, time: minTime };
    };

    const kvaMax = findGlobalMax('maxKVA', 'maxKVATime', todayStats?.maxKVA, todayStats?.maxKVARec?.timestamp);
    const kvaMin = findGlobalMin('minKVA', 'minKVATime', todayStats?.minKVA, todayStats?.minKVARec?.timestamp);
    const kwMax = findGlobalMax('maxKW', 'maxKWTime', todayStats?.maxKW, todayStats?.maxKWRec?.timestamp);
    const kwMin = findGlobalMin('minKW', 'minKWTime', todayStats?.minKW, todayStats?.minKWRec?.timestamp);

    // PF Avg
    let totalPF = historicalUsages.reduce((sum, u) => sum + (u.avgPF || 0), 0);
    let countPF = historicalUsages.length;
    if (todayStats) {
      totalPF += (todayStats.avgPF || 0);
      countPF += 1;
    }
    const globalAvgPF = countPF > 0 ? totalPF / countPF : 0;

    res.json({
      kva: { max: kvaMax.val, maxTime: kvaMax.time, min: kvaMin.val, minTime: kvaMin.time },
      kw: { max: kwMax.val, maxTime: kwMax.time, min: kwMin.val, minTime: kwMin.time },
      avgPF: globalAvgPF
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
    if (!Array.isArray(deviceIds)) deviceIds = [deviceIds];

    const start = fromDate ? new Date(fromDate) : new Date();
    if (!fromDate) start.setHours(0, 0, 0, 0);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    let totalConsumed = 0;
    
    let globalMaxKVA = 0;
    let globalMaxKVATime = null;
    let globalMinKVA = null;
    let globalMinKVATime = null;

    let globalMaxKW = 0;
    let globalMaxKWTime = null;
    let globalMinKW = null;
    let globalMinKWTime = null;

    let globalAvgPF = 0;
    let pfCount = 0;

    for (const dId of deviceIds) {
      // Archived
      const summaries = await DailyUsage.find({ deviceId: dId, date: { $gte: start, $lt: todayStart } }).lean();
      for (const s of summaries) {
        totalConsumed += (s.totalKWh || 0);

        // Max KVA
        if ((s.maxKVA || 0) > globalMaxKVA) {
          globalMaxKVA = s.maxKVA;
          globalMaxKVATime = s.maxKVATime;
        }
        // Min KVA (excluding 0)
        if (s.minKVA > 0 && (globalMinKVA === null || s.minKVA < globalMinKVA)) {
          globalMinKVA = s.minKVA;
          globalMinKVATime = s.minKVATime;
        }

        // Max KW
        if ((s.maxKW || 0) > globalMaxKW) {
          globalMaxKW = s.maxKW;
          globalMaxKWTime = s.maxKWTime;
        }
        // Min KW (excluding 0)
        if (s.minKW > 0 && (globalMinKW === null || s.minKW < globalMinKW)) {
          globalMinKW = s.minKW;
          globalMinKWTime = s.minKWTime;
        }

        globalAvgPF += (s.avgPF || 0);
        pfCount++;
      }
      
      // Live Today
      totalConsumed += await calculateTodayConsumption(dId);
      const liveData = await MeterData.aggregate([
        { $match: { deviceId: dId, timestamp: { $gte: todayStart } } },
        { $group: { 
            _id: null, 
            maxKVA: { $max: "$KVA" }, 
            minKVA: { $min: { $cond: [{ $gt: ["$KVA", 0] }, "$KVA", 700000] } },
            maxKW: { $max: "$KW" }, 
            minKW: { $min: { $cond: [{ $gt: ["$KW", 0] }, "$KW", 700000] } },
            avgPF: { $avg: "$PF" } 
        } }
      ]);

      if (liveData.length > 0) {
        const live = liveData[0];
        if (live.minKVA === 700000) live.minKVA = 0;
        if (live.minKW === 700000) live.minKW = 0;

        // Max KVA
        if (live.maxKVA > globalMaxKVA) {
          globalMaxKVA = live.maxKVA;
          const rec = await MeterData.findOne({ deviceId: dId, timestamp: { $gte: todayStart }, KVA: live.maxKVA }).sort({ timestamp: 1 }).lean();
          globalMaxKVATime = rec ? rec.timestamp : new Date();
        }
        // Min KVA
        if (live.minKVA > 0 && (globalMinKVA === null || live.minKVA < globalMinKVA)) {
          globalMinKVA = live.minKVA;
          const rec = await MeterData.findOne({ deviceId: dId, timestamp: { $gte: todayStart }, KVA: live.minKVA }).sort({ timestamp: 1 }).lean();
          globalMinKVATime = rec ? rec.timestamp : new Date();
        }

        // Max KW
        if (live.maxKW > globalMaxKW) {
          globalMaxKW = live.maxKW;
          const rec = await MeterData.findOne({ deviceId: dId, timestamp: { $gte: todayStart }, KW: live.maxKW }).sort({ timestamp: 1 }).lean();
          globalMaxKWTime = rec ? rec.timestamp : new Date();
        }
        // Min KW
        if (live.minKW > 0 && (globalMinKW === null || live.minKW < globalMinKW)) {
          globalMinKW = live.minKW;
          const rec = await MeterData.findOne({ deviceId: dId, timestamp: { $gte: todayStart }, KW: live.minKW }).sort({ timestamp: 1 }).lean();
          globalMinKWTime = rec ? rec.timestamp : new Date();
        }

        globalAvgPF += (live.avgPF || 0);
        pfCount++;
      }
    }

    res.json({
      totalConsumedKWh: totalConsumed,
      avgPF: pfCount > 0 ? globalAvgPF / pfCount : 0,
      kva: { 
        max: globalMaxKVA, 
        maxTime: globalMaxKVATime,
        min: globalMinKVA || 0,
        minTime: globalMinKVATime
      },
      kw: {
        max: globalMaxKW,
        maxTime: globalMaxKWTime,
        min: globalMinKW || 0,
        minTime: globalMinKWTime
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Get Consumption for a specific date range
app.get('/api/analysis/range-usage', async (req, res) => {
  try {
    const { deviceId, fromDate, toDate } = req.query;
    if (!deviceId || !fromDate || !toDate) {
      return res.status(400).json({ error: 'deviceId, fromDate, and toDate are required' });
    }

    const start = new Date(fromDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(toDate);
    end.setHours(0, 0, 0, 0);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // 1. Get archived totals for the range
    let usages = await DailyUsage.find({
      deviceId,
      date: { $gte: start, $lte: end }
    }).lean();

    // 1.1 Fallback: If no summaries found but range is recent, calculate consumption live
    if (usages.length === 0 && end < todayStart) {
      const dayDiff = Math.ceil((end - start) / (700 * 60 * 60 * 24)) + 1;
      if (dayDiff <= 3) {
        const fallbackData = [];
        for (let i = 0; i < dayDiff; i++) {
          const d = new Date(start);
          d.setDate(d.getDate() + i);
          const stats = await calculateHistoricalDayStats(deviceId, d);
          if (stats) fallbackData.push(stats);
        }
        usages = fallbackData;
      }
    }

    let totalConsumed = usages.reduce((sum, u) => sum + (u.totalKWh || 0), 0);

    // 2. If end date includes today, add live today consumption
    if (end >= todayStart) {
      totalConsumed += await calculateTodayConsumption(deviceId);
    }

    res.json({ totalKWhConsumed: totalConsumed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Get Monthly Consumption
app.get('/api/analysis/monthly-usage', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const monthlyData = await DailyUsage.aggregate([
      { $match: { deviceId } },
      { $group: {
        _id: {
          year: { $year: "$date" },
          month: { $month: "$date" }
        },
        totalKWh: { $sum: "$totalKWh" }
      }},
      { $sort: { "_id.year": -1, "_id.month": -1 } }
    ]);

    // Format for easier consumption
    const formattedData = monthlyData.map(d => ({
      year: d._id.year,
      month: d._id.month,
      totalKWh: d.totalKWh
    }));

    // Add current month's live data
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    let currentMonthEntry = formattedData.find(d => d.year === currentYear && d.month === currentMonth);
    const liveToday = await calculateTodayConsumption(deviceId);

    if (currentMonthEntry) {
      currentMonthEntry.totalKWh += liveToday;
    } else {
      formattedData.unshift({
        year: currentYear,
        month: currentMonth,
        totalKWh: liveToday
      });
    }

    res.json(formattedData);
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

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`🚀 Rice Mill Server v2.1 (EMS1) listening on port ${PORT}`);
});

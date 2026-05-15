const mqtt = require('mqtt'); // We will run from the server directory to use node_modules

const MQTT_BROKER = 'mqtt://broker.emqx.io:1883';
const MQTT_TOPIC = 'EMS1/data';

const client = mqtt.connect(MQTT_BROKER);

client.on('connect', () => {
  console.log('Connected to broker');
  const payload = {
    "meterId": 1,
    "kW_Total": 120,
    "kW_R": 40,
    "kW_Y": 40,
    "kW_B": 40,
    "kVAR_Total": 10,
    "kVAR_R": 3,
    "kVAR_Y": 3,
    "kVAR_B": 4,
    "kVA_Total": 125,
    "kVA_R": 42,
    "kVA_Y": 41,
    "kVA_B": 42,
    "PF_Avg": 0.96,
    "PF_R": 0.95,
    "PF_Y": 0.97,
    "PF_B": 0.96,
    "kWh": 10050.25,
    "kVAh": 10100.50,
    "kVARh_Ind": 200,
    "kVARh_Cap": 50,
    "timestamp": new Date().toISOString()
  };

  console.log('Publishing message to', MQTT_TOPIC);
  client.publish(MQTT_TOPIC, JSON.stringify(payload), (err) => {
    if (err) {
      console.error('Publish error:', err);
    } else {
      console.log('Message published successfully');
    }
    client.end();
  });
});

client.on('error', (err) => {
  console.error('Connection error:', err);
});

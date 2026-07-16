const mqtt = require('mqtt'); // We will run from the server directory to use node_modules

const MQTT_BROKER = 'mqtt://broker.emqx.io:1883';
const MQTT_TOPIC = 'EMS1/data';

const client = mqtt.connect(MQTT_BROKER);

client.on('connect', () => {
  console.log('Connected to broker');
  const payload = {
    "meterId": 1,
    "TotalKW": 62902.88,
    "TotalKVA": 65210.2,
    "TotalKVAR": 1504.9,
    "TotalPF": 0.997144,
    "REG0": 0,
    "REG1": 0,
    "REG2": 2461,
    "REG3": 18063,
    "ImportWh": 161302.159,
    "ImportVAh": 162855.196,
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

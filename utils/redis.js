// valorant-tourney/utils/redis.js
const Redis = require('ioredis');

// เชื่อมต่อ Redis (ค่า Default คือ localhost:6379)
// ถ้าใช้ Docker หรือ Cloud ให้เปลี่ยนค่าใน .env
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

redis.on('connect', () => console.log('✅ Redis Connected'));
redis.on('error', (err) => console.error('❌ Redis Error:', err));

module.exports = redis;
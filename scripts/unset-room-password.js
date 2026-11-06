// One-off migration: remove the deprecated `roomPassword` field from all matches.
// Usage: MONGO_URI=... node scripts/unset-room-password.js
require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/valorant-tourney');
    const result = await mongoose.connection.collection('matches').updateMany(
        { roomPassword: { $exists: true } },
        { $unset: { roomPassword: '' } }
    );
    console.log(`matches updated: ${result.modifiedCount}`);
    await mongoose.disconnect();
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});

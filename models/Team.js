// models/Team.js
const mongoose = require('mongoose');

const MemberSchema = new mongoose.Schema({
    name: String,
    tag: String,
    role: { type: String, enum: ['Main', 'Sub', 'Coach'], default: 'Main' },
    status: { type: String, enum: ['approved', 'pending', 'rejected'], default: 'pending' },
    pendingUpdate: {
        name: String,
        tag: String
    }
});

const TeamSchema = new mongoose.Schema({
    // [NEW] username สำหรับ Login (ห้ามซ้ำ, แก้ไขยาก)
    username: { 
        type: String, 
        required: true, 
        unique: true, 
        lowercase: true, // บังคับตัวเล็กหมดเพื่อลดปัญหา Case sensitive
        trim: true 
    },
    // [MODIFIED] name คือ Display Name (แสดงผลในตารางแข่ง)
    name: { type: String, required: true }, 
    shortName: { type: String, required: true, maxlength: 4, uppercase: true },
    password: { type: String, required: true },
    logo: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'approved'], default: 'pending' },
    
    members: [MemberSchema],
    rosterLocked: { type: Boolean, default: false },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 }
}, { timestamps: true }); // เพิ่ม Timestamps เพื่อดูเวลาสมัคร/แก้ไขล่าสุด

module.exports = mongoose.model('Team', TeamSchema);
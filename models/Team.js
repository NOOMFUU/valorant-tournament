const mongoose = require('mongoose');

const MemberSchema = new mongoose.Schema({
    name: String,
    tag: String,
    role: { type: String, enum: ['Main', 'Sub', 'Coach'], default: 'Main' },
    status: { type: String, enum: ['approved', 'pending', 'rejected'], default: 'pending' },
    
    // *** NEW: เก็บข้อมูลใหม่ที่รออนุมัติ (Old vs New) ***
    pendingUpdate: {
        name: String,
        tag: String
    }
});

const TeamSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    shortName: { type: String, required: true, maxlength: 4, uppercase: true },
    password: { type: String, required: true },
    logo: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'approved'], default: 'pending' },
    
    members: [MemberSchema],
    
    // ตัวล็อค: ถ้าเป็น false (ครั้งแรก) จะ Auto Approve, ถ้า true (เคยส่งแล้ว) จะต้องรออนุมัติ
    rosterLocked: { type: Boolean, default: false },
    
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 }
});

module.exports = mongoose.model('Team', TeamSchema);
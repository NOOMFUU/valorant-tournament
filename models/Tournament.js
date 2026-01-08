const mongoose = require('mongoose');

const TournamentSchema = new mongoose.Schema({
    name: { type: String, required: true },
    status: { type: String, enum: ['setup', 'active', 'finished'], default: 'setup' },
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Team' }],
    
    mapPool: { 
        type: [String], 
        default: ['Abyss', 'Ascent', 'Bind', 'Haven', 'Lotus', 'Sunset', 'Pearl'] 
    },

    stages: [{
        name: String, 
        // เพิ่ม gsl และ triple_elim
        type: { type: String, enum: ['round_robin', 'single_elim', 'double_elim', 'triple_elim', 'swiss', 'gsl'], default: 'single_elim' },
        settings: {
            defaultFormat: { type: String, enum: ['BO1', 'BO3', 'BO5'], default: 'BO1' },
            roundCount: { type: Number, default: 1 }, 
            swissRounds: { type: Number, default: 3 },
            
            // Setting ใหม่
            randomize: { type: Boolean, default: false }, // ปุ่ม Random Seed
            hasThirdPlace: { type: Boolean, default: false }, // ปุ่มหาที่ 3 (Single Elim)
            
            // สำหรับ Stage-to-Stage
            sourceStageIndex: { type: Number, default: -1 }, // -1 = Manual, 0+ = จาก Stage นั้น
            advanceCount: { type: Number, default: 0 }, // จำนวนทีมที่ดึงมา (เช่น Top 2)
            // 'cross_group' = เอาที่ 1 เจอที่ 2 ของอีกกลุ่ม (Standard Seed), 'top_standing' = เรียงตามคะแนนรวม
            advanceMethod: { type: String, enum: ['top_standing', 'cross_group'], default: 'top_standing' }
        },
        stageParticipants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Team' }],
        matches: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Match' }]
    }]
}, { timestamps: true });

module.exports = mongoose.model('Tournament', TournamentSchema);
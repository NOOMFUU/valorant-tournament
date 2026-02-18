const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const Team = require('../models/Team');
const Match = require('../models/Match');

let imgbbUploader;
try { imgbbUploader = require('imgbb-uploader'); } catch (e) {}

const getFileUrl = (file) => {
    if (!file) return null;
    if (file.path && (file.path.startsWith('http') || file.path.startsWith('https'))) return file.path;
    return `/uploads/${file.filename}`;
};

const generateUploadFilename = async (req, file) => {
    const originalExt = path.extname(file.originalname) || '.png';
    const timestamp = Date.now();
    let prefix = 'upload';

    try {
        if (file.fieldname === 'logo') {
            if (req.originalUrl.includes('/register')) {
                prefix = `team-registration-logo`;
            } else if (req.method === 'POST' && req.originalUrl.includes('/teams')) {
                prefix = `team-admin-create-logo`;
            } else {
                // Support both Admin (params.id) and Team (user.id)
                const teamId = req.params.id || (req.user ? req.user.id : null);
                if (teamId) {
                    const team = await Team.findById(teamId).select('name');
                    // Replace spaces with underscores and remove special chars
                    const safeName = team ? team.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() : 'unknown';
                    prefix = `team-${safeName}-logo`;
                }
            }
        } else if (req.params.id) {
                const match = await Match.findById(req.params.id).select('matchNumber');
                const matchNum = match ? String(match.matchNumber).padStart(3, '0') : req.params.id;
                if (req.originalUrl.includes('submit-score')) {
                    const mapIndex = file.fieldname.split('_')[1] || '0';
                    prefix = `match-${matchNum}-score-map${mapIndex}`;
                } else if (req.originalUrl.includes('claim-forfeit')) {
                    prefix = `match-${matchNum}-forfeit-proof`;
                }
        }
    } catch (e) {
        console.error('Error generating filename:', e);
    }
    return `${prefix}-${timestamp}${originalExt}`;
};

function ImgbbStorage(opts) { this.apiKey = opts.apiKey; }
ImgbbStorage.prototype._handleFile = function(req, file, cb) {
    if (!this.apiKey) return cb(new Error('IMGBB API key is missing.'));
    const stream = file.stream; const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', (err) => cb(err));
    stream.on('end', async () => {
        try {
            const buffer = Buffer.concat(chunks);
            const filename = await generateUploadFilename(req, file);
            const response = await imgbbUploader({ apiKey: this.apiKey, base64string: buffer.toString('base64'), name: filename });
            cb(null, { path: response.url, size: response.size, filename: response.image.filename });
        } catch (error) { cb(error); }
    });
};
ImgbbStorage.prototype._removeFile = function(req, file, cb) { cb(null); };

function CustomLocalDiskStorage(opts) { this.getDestination = opts.destination; this.getFilename = opts.filename; }
CustomLocalDiskStorage.prototype._handleFile = function(req, file, cb) {
    this.getDestination(req, file, (err, destination) => {
        if (err) return cb(err);
        this.getFilename(req, file, (err, filename) => {
            if (err) return cb(err);
            const finalPath = path.join(destination, filename);
            const outStream = fs.createWriteStream(finalPath);
            file.stream.pipe(outStream);
            outStream.on('error', cb);
            outStream.on('finish', () => cb(null, { destination, filename, path: finalPath, size: outStream.bytesWritten }));
        });
    });
};
CustomLocalDiskStorage.prototype._removeFile = function(req, file, cb) { fs.unlink(file.path, cb); };

const fileFilter = (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only JPG and PNG are allowed.'), false);
    }
};

let upload;
if (process.env.IMGBB_API_KEY && imgbbUploader) {
    upload = multer({ storage: new ImgbbStorage({ apiKey: process.env.IMGBB_API_KEY }), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter });
} else if (process.env.CLOUDINARY_URL) {
    const cloudStorage = new CloudinaryStorage({
        cloudinary: cloudinary,
        params: {
            folder: 'valorant-tourney', allowed_formats: ['jpg', 'png', 'jpeg'],
            public_id: async (req, file) => path.parse(await generateUploadFilename(req, file)).name
        },
    });
    upload = multer({ storage: cloudStorage, fileFilter });
} else {
    upload = multer({
        storage: new CustomLocalDiskStorage({
            destination: (req, file, cb) => { const dir = 'public/uploads'; if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); cb(null, dir); },
            filename: (req, file, cb) => generateUploadFilename(req, file).then(f => cb(null, f)).catch(e => cb(e))
        }),
        limits: { fileSize: 5 * 1024 * 1024 },
        fileFilter
    });
}

module.exports = { upload, getFileUrl };

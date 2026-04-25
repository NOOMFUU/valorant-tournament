const logger = require('../utils/logger');

const validate = (schema) => async (req, res, next) => {
    try {
        await schema.parseAsync({
            body: req.body,
            query: req.query,
            params: req.params,
        });
        return next();
    } catch (error) {
        logger.warn('Validation Failed', { errors: error.errors, path: req.originalUrl, ip: req.ip });
        
        return res.status(400).json({
            success: false,
            msg: 'Invalid format',
            errors: error.errors.map(err => ({
                path: err.path.join('.'),
                message: err.message
            }))
        });
    }
};

module.exports = validate;

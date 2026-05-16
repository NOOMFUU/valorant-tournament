const axios = require('axios');
const logger = require('./logger'); // Use the Winston logger we previously created

const HENRIK_API_BASE = 'https://api.henrikdev.xyz/valorant';

/**
 * Fetch general account information using HenrikDev API
 * @param {string} name - In-game Name (without the #)
 * @param {string} tag - In-game Tagline
 * @returns {Promise<{puuid: string, level: number, card: string}|null>}
 */
async function verifyRiotAccount(name, tag) {
    try {
        const encodedName = encodeURIComponent(name.trim());
        const encodedTag = encodeURIComponent(tag.trim().replace('#', ''));

        // Note: As of latest HenrikDev API updates, a token is generally recommended but v1/account often works without one.
        // We configure a timeout so the request doesn't hang the backend.
        const response = await axios.get(`${HENRIK_API_BASE}/v1/account/${encodedName}/${encodedTag}`, {
            timeout: 8000
        });

        if (response.data && response.data.data) {
            const data = response.data.data;
            return {
                puuid: data.puuid,
                level: data.account_level,
                card: data.card?.small || ''
            };
        }
        return null;
    } catch (error) {
        if (error.response && error.response.status === 404) {
            // Player not found
            return null;
        }
        // Log standard API errors or rate limits
        logger.error(`Riot API Error for ${name}#${tag}:`, {
            message: error.message,
            status: error.response?.status
        });

        // Throw an explicit error to distinguish between "Not Found" and "API Service Down"
        throw new Error('RIOT_API_DOWN');
    }
}

module.exports = {
    verifyRiotAccount
};

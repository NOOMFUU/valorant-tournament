const { z } = require('zod');

// Authentication schemas
const registerSchema = z.object({
    params: z.object({}),
    query: z.object({}),
    body: z.object({
        name: z.string().min(2, "Team name must be at least 2 characters").max(50),
        shortName: z.string().min(2).max(10),
        username: z.string().min(4).max(30),
        password: z.string().min(6, "Password must be at least 6 characters"),
        captainDiscordId: z.string().optional()
    })
});

const loginSchema = z.object({
    params: z.object({}),
    query: z.object({}),
    body: z.object({
        username: z.string().min(1, "Username is required"),
        password: z.string().min(1, "Password is required")
    })
});

// Match action schemas
const swapTeamsSchema = z.object({
    params: z.object({}),
    query: z.object({}),
    body: z.object({
        match1Id: z.string().min(1),
        slot1: z.enum(['teamA', 'teamB']),
        match2Id: z.string().min(1),
        slot2: z.enum(['teamA', 'teamB'])
    })
});

const validateScoreSchema = z.object({
    params: z.object({
        id: z.string()
    }),
    query: z.object({}),
    body: z.object({
        mapIndex: z.union([z.string(), z.number()]),
        teamAScore: z.union([z.string(), z.number()]).optional(),
        teamBScore: z.union([z.string(), z.number()]).optional()
    })
});

module.exports = {
    registerSchema,
    loginSchema,
    swapTeamsSchema,
    validateScoreSchema
};

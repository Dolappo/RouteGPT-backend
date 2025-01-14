const express = require('express');
const router = express.Router();
const { getDirections } = require('../controllers/directionsController');

/**
 * @swagger
 * /api/directions:
 *   post:
 *     summary: Get directions using natural language
 *     description: Converts a natural language query into directions using Gemini AI and Google Maps
 *     tags:
 *       - Directions
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - query
 *             properties:
 *               query:
 *                 type: string
 *                 description: Natural language query for directions
 *                 example: "How do I get to 6, Ibafo road ondo state from Ikate, Lekki lagos?"
 *     responses:
 *       200:
 *         description: Successful response with directions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 response:
 *                   type: string
 *                   description: Formatted directions in natural language
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   description: Error message
 */
router.post('/directions', getDirections);

module.exports = router; 
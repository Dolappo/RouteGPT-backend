const express = require('express');
const path = require('path');
const router = require('./routes/directions');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const { loadEnvironment } = require('./utils/environment');

// Load environment variables only in development
if (process.env.NODE_ENV !== 'production') {
    if (!loadEnvironment()) {
        console.error('Failed to load environment variables');
        process.exit(1);
    }
}

const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'RouteGPT API',
            version: '1.0.0',
            description: 'An API that combines Gemini AI with Google Maps for natural language directions',
        },
        servers: [
            {
                url: process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${process.env.PORT || 3000}`,
                description: 'API Server',
            },
        ],
    },
    apis: ['./api/routes/*.js'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

const app = express();
app.use(express.json());

// CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// Swagger documentation route
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Routes
app.use('/api', router);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Only start the server if not running on Vercel
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`Swagger documentation available at http://localhost:${PORT}/api-docs`);
    });
}

// Export the app for Vercel
module.exports = app; 
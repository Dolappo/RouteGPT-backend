const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Client, TravelMode, TransitMode } = require('@googlemaps/google-maps-services-js');
const { loadEnvironment } = require('../utils/environment');
const { routeCache } = require('../utils/cache');

// Ensure environment is loaded
if (!loadEnvironment()) {
    console.error('Failed to load environment variables');
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const mapsClient = new Client({});

async function extractLocationsAndMode(query) { 
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });

        const prompt = `
        Extract the origin, destination, and transportation mode from this query.
        For Nigerian locations, add "Lagos, Nigeria" if it's a Lagos location without full specification.
        
        Return ONLY a valid JSON object with "origin", "destination", and "mode" keys.
        
        For mode, detect these keywords and map them as follows:
        - "bike" or "motorcycle" → set mode to "bike"
        - "car" or "drive" → set mode to "car"
        - "bus" → set mode to "bus"
        - "train" → set mode to "train"
        If no mode is mentioned, default to "car".
        
        Examples:
        - "Ikeja" → "Ikeja, Lagos, Nigeria"
        - "Victoria Island" → "Victoria Island, Lagos, Nigeria"
        - "Lekki" → "Lekki, Lagos, Nigeria"
        
        DO NOT include any markdown formatting, backticks, or additional text.
        Example format: {"origin": "Victoria Island, Lagos, Nigeria", "destination": "Ikeja, Lagos, Nigeria", "mode": "car"}
        
        Query: "${query}"
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text().trim();
        
        let jsonStr = text;
        if (text.includes('```')) {
            jsonStr = text.replace(/```json\n?|\n?```/g, '').trim();
        }
        
        const parsedResponse = JSON.parse(jsonStr);
        
        if (!parsedResponse.origin || !parsedResponse.destination) {
            throw new Error('Failed to extract valid locations from query');
        }

        parsedResponse.origin = addLocationQualifier(parsedResponse.origin);
        parsedResponse.destination = addLocationQualifier(parsedResponse.destination);

        parsedResponse.mode = parsedResponse.mode || 'car';

        const modeMapping = {
            'bike': { mode: 'DRIVING', avoid: ['highways'] },
            'car': { mode: 'DRIVING' },
            'bus': { mode: 'TRANSIT', transit_mode: ['BUS'] },
            'train': { mode: 'TRANSIT', transit_mode: ['TRAIN'] }
        };
        
        parsedResponse.modeConfig = modeMapping[parsedResponse.mode] || modeMapping.car;
        
        console.log('Extracted and enhanced data:', parsedResponse);
        return parsedResponse;
    } catch (error) {
        console.error('Error in extractLocationsAndMode:', error);
        console.error('Raw response:', response?.text());
        throw new Error(`Failed to extract locations and mode: ${error.message}`);
    }
}

function addLocationQualifier(location) {
    const lagosAreas = [
        'Ikeja', 'Victoria Island', 'Lekki', 'Ajah', 'Ikoyi', 'Surulere', 
        'Yaba', 'Apapa', 'Oshodi', 'Mushin', 'Maryland', 'Ojota', 'Ogudu',
        'Gbagada', 'Magodo', 'Ojodu', 'Berger', 'Agege', 'Ikorodu', 'Epe'
    ];

    if (lagosAreas.some(area => 
        location.toLowerCase().includes(area.toLowerCase()) && 
        !location.toLowerCase().includes('lagos'))) {
        return `${location}, Lagos, Nigeria`;
    }

    if (!location.toLowerCase().includes('nigeria')) {
        return `${location}, Nigeria`;
    }

    return location;
}

function getDistanceContext(distance) {
    const meters = distance?.value || 0;
    const kilometers = meters / 1000;
    
    if (kilometers < 3) return 'nearby';
    if (kilometers < 10) return 'short';
    if (kilometers < 30) return 'medium';
    return 'long';
}

function getTrafficStatus(normalDuration, trafficDuration) {
    if (!normalDuration || !trafficDuration) return 'Unknown';
    
    const difference = trafficDuration - normalDuration;
    const percentageIncrease = (difference / normalDuration) * 100;
    
    if (percentageIncrease <= 10) return 'Light traffic';
    if (percentageIncrease <= 30) return 'Moderate traffic';
    if (percentageIncrease <= 50) return 'Heavy traffic';
    return 'Severe traffic';
}

async function classifyQuery(query) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });

        const prompt = `
        Classify this query into ONE of these categories:
        1. "directions" - asking for route directions
        2. "traffic_check" - asking about current traffic conditions
        3. "duration_check" - asking about travel time
        4. "route_status" - asking about road conditions or closures
        
        Return ONLY the category as a single word, no additional text.
        
        Example queries and their classifications:
        - "How do I get to Lagos from Ibadan?" → "directions"
        - "Is there traffic on Third Mainland Bridge?" → "traffic_check"
        - "How long will it take to reach Ikeja from VI?" → "duration_check"
        - "Which roads should I avoid in Lekki right now?" → "route_status"
        
        Query: "${query}"
        `;

        const result = await model.generateContent(prompt);
        const queryType = result.response.text().trim().toLowerCase();
        console.log('Query classified as:', queryType);
        return queryType;
    } catch (error) {
        console.error('Error classifying query:', error);
        return 'directions'; // Default to directions if classification fails
    }
}

async function formatDirections(directionsData) {
    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-pro",
            generationConfig: {
                temperature: 0.7,
                topP: 0.8,
                topK: 40
            }
        });

        const route = directionsData.routes[0];
        const steps = route.legs[0].steps;
        
        const prompt = `
        Create step-by-step directions:
        Origin: ${steps[0].instructions}
        Steps: ${JSON.stringify(steps.map(s => s.instructions))}
        Distance: ${route.legs[0].distance.text}
        Duration: ${route.legs[0].duration_in_traffic?.text || route.legs[0].duration.text}
        
        Format: numbered steps, include distance and time at end.
        Keep it brief and clear.
        `;

        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (error) {
        console.error('Error in formatDirections:', error);
        return 'Error formatting directions';
    }
}

async function formatTrafficCheck(directionsData, origin, destination) {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    
    const distance = directionsData.routes[0]?.legs[0]?.distance;
    const distanceContext = getDistanceContext(distance);
    
    const prompt = `
    Create a friendly traffic report for the route from ${origin} to ${destination}.
    The distance is ${distance?.text} (${distanceContext} distance).
    
    Adjust your response based on the distance:
    - Nearby: Focus on immediate street conditions
    - Short: Focus on current traffic flow
    - Medium: Include alternative routes and traffic patterns
    - Long: Include major highways, rest stops, and broad traffic patterns
    
    Use this data: ${JSON.stringify(directionsData)}
    Keep it casual and helpful, matching the advice to the journey length.
    `;

    const result = await model.generateContent(prompt);
    return result.response.text();
}

async function formatDurationCheck(directionsData, origin, destination) {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    
    const distance = directionsData.routes[0]?.legs[0]?.distance;
    const distanceContext = getDistanceContext(distance);
    
    const prompt = `
    Create a friendly, conversational time estimate from ${origin} to ${destination}.
    The distance is ${distance?.text} (${distanceContext} distance).
    
    Make it sound like a human conversation, adjusting language based on distance:
    - For nearby (< 3km): Focus on minutes, mention walking if relevant
    - For short trips (< 10km): Keep it simple, focus on current conditions
    - For medium trips (< 30km): Include traffic patterns and alternative routes
    - For long trips: Include breaks, rest stops, and broader traffic patterns
    
    Use this data: ${JSON.stringify(directionsData)}
    Keep it natural and friendly, matching the tone to the distance context.
    `;

    const result = await model.generateContent(prompt);
    return result.response.text();
}

async function formatRouteStatus(directionsData, origin, destination) {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    
    const prompt = `
    Create a friendly, conversational route status update between ${origin} and ${destination}.
    
    Make it sound like local advice from someone who just drove that route.
    Include:
    1. Road conditions
    2. Any construction or closures
    3. Traffic hotspots
    4. Suggested alternatives
    
    Use this data: ${JSON.stringify(directionsData)}
    Keep it natural and helpful, like you're sharing local knowledge with a friend.
    `;

    const result = await model.generateContent(prompt);
    return result.response.text();
}

async function getDirections(req, res) {
    try {
        const { query } = req.body;
        
        // Check cache first
        const cacheKey = query.toLowerCase().trim();
        const cachedResponse = routeCache.get(cacheKey);
        if (cachedResponse) {
            return res.json(cachedResponse);
        }

        if (!query) {
            return res.status(400).json({ error: 'Query is required' });
        }

        // Run location extraction and query classification in parallel
        const [
            { origin, destination, mode, modeConfig },
            queryType
        ] = await Promise.all([
            extractLocationsAndMode(query),
            classifyQuery(query)
        ]);

        console.log('Query type:', queryType);

        const params = {
            origin,
            destination,
            key: process.env.GOOGLE_MAPS_API_KEY,
            ...modeConfig,
            departure_time: 'now',
            alternatives: true,
            traffic_model: 'best_guess'
        };

        const directionsResponse = await mapsClient.directions({ params });
        
        if (!directionsResponse.data || directionsResponse.data.status !== 'OK') {
            throw new Error(`Invalid response: ${directionsResponse.data?.status}`);
        }

        // Simplify the response data to include only what we need
        const responseData = {
            routes: directionsResponse.data.routes.map(route => ({
                summary: route.summary,
                legs: route.legs.map(leg => ({
                    distance: leg.distance,
                    duration: leg.duration,
                    duration_in_traffic: leg.duration_in_traffic,
                    steps: leg.steps.map(step => ({
                        instructions: step.html_instructions,
                        distance: step.distance,
                        duration: step.duration,
                        maneuver: step.maneuver
                    }))
                }))
            })),
            mode,
            current_time: new Date().toLocaleTimeString()
        };

        // Format response based on query type
        const formattingFunction = {
            'traffic_check': formatTrafficCheck,
            'duration_check': formatDurationCheck,
            'route_status': formatRouteStatus
        }[queryType] || formatDirections;

        const formattedResponse = await formattingFunction(responseData, origin, destination);

        // Cache the response before sending
        routeCache.set(cacheKey, { 
            response: formattedResponse, 
            query_type: queryType 
        });

        res.json({ 
            response: formattedResponse, 
            query_type: queryType 
        });

    } catch (error) {
        console.error('Error:', error.message);
        res.status(error.status || 500).json({ 
            error: 'Error processing request', 
            details: error.message 
        });
    }
}

module.exports = {
    getDirections
}; 
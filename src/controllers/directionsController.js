const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Client, TravelMode, TransitMode } = require('@googlemaps/google-maps-services-js');
const { loadEnvironment } = require('../utils/environment');

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
        
        // Validate and enhance locations
        if (!parsedResponse.origin || !parsedResponse.destination) {
            throw new Error('Failed to extract valid locations from query');
        }

        // Add Lagos, Nigeria to locations if not already specified
        parsedResponse.origin = addLocationQualifier(parsedResponse.origin);
        parsedResponse.destination = addLocationQualifier(parsedResponse.destination);

        // Default to car if no mode specified
        parsedResponse.mode = parsedResponse.mode || 'car';

        // Map the mode to Google Maps API parameters
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

// Helper function to add location qualifier
function addLocationQualifier(location) {
    const lagosAreas = [
        'Ikeja', 'Victoria Island', 'Lekki', 'Ajah', 'Ikoyi', 'Surulere', 
        'Yaba', 'Apapa', 'Oshodi', 'Mushin', 'Maryland', 'Ojota', 'Ogudu',
        'Gbagada', 'Magodo', 'Ojodu', 'Berger', 'Agege', 'Ikorodu', 'Epe'
    ];

    // Check if location is a known Lagos area and doesn't already have "Lagos" specified
    if (lagosAreas.some(area => 
        location.toLowerCase().includes(area.toLowerCase()) && 
        !location.toLowerCase().includes('lagos'))) {
        return `${location}, Lagos, Nigeria`;
    }

    // If location doesn't have "Nigeria" specified, add it
    if (!location.toLowerCase().includes('nigeria')) {
        return `${location}, Nigeria`;
    }

    return location;
}

async function formatDirections(directionsData) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });

        const prompt = `
        Convert these directions into a natural, friendly response.
        Include the following information:
        1. Estimated travel time (both with and without traffic)
        2. Traffic conditions and any delays
        3. Alternative routes if available
        4. Any roads to avoid due to traffic or warnings
        5. For public transport, include departure times and any relevant transit information
        
        Make it conversational but concise. If there are significant delays, suggest alternative routes or times.
        
        Current time: ${directionsData.current_time}
        Mode of transport: ${directionsData.mode}
        
        Data: ${JSON.stringify(directionsData)}
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error('Error in formatDirections:', error);
        throw new Error(`Failed to format directions: ${error.message}`);
    }
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

// Helper function to format distance for conversation
function getDistanceContext(distance) {
    const meters = distance?.value || 0;
    const kilometers = meters / 1000;
    
    if (kilometers < 3) {
        return 'nearby'; // For very short distances
    } else if (kilometers < 10) {
        return 'short'; // For local trips
    } else if (kilometers < 30) {
        return 'medium'; // For cross-city trips
    } else {
        return 'long'; // For inter-city or long distances
    }
}

async function formatDurationCheck(directionsData, origin, destination) {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    
    // Get distance context
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
    
    Include:
    1. Time estimate based on distance context
    2. Current conditions
    3. Best and worst scenarios
    4. Relevant advice for the distance
    
    Example styles based on distance:
    Nearby: "It's just around the corner - about 5 minutes by car, or you could even walk there in 15 minutes!"
    
    Short: "It's a quick 15-minute drive. Traffic's moving well right now, so you should get there in no time."
    
    Medium: "It usually takes about 45 minutes. Right now the traffic's decent, so you should make it in that time. 
    During rush hour it can take up to an hour though, so plan accordingly."
    
    Long: "For this journey, you should plan for about 2 hours of travel time. Make sure to factor in a short break 
    along the way. Traffic's typically better in the morning, so I'd recommend leaving early if you can."
    
    Use this data: ${JSON.stringify(directionsData)}
    Keep it natural and friendly, matching the tone to the distance context.
    `;

    const result = await model.generateContent(prompt);
    return result.response.text();
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
    
    Include relevant information for the distance:
    1. Current conditions
    2. Delays or congestion
    3. Areas to avoid
    4. Alternatives if relevant
    
    Example style for ${distanceContext} distance:
    Nearby: "The streets around there are pretty clear right now - you should have no trouble getting there."
    
    Short: "Traffic's moving smoothly on Victoria Island right now. You shouldn't hit any major delays."
    
    Medium: "Heads up - there's some congestion on Third Mainland Bridge, but the alternative route through 
    Ikorodu Road is flowing nicely. Might save you about 15 minutes."
    
    Long: "On the Lagos-Ibadan expressway, traffic's building up near the Sagamu interchange. You might want 
    to consider the alternative route through Ikorodu, and don't forget there's a good rest stop about halfway."
    
    Use this data: ${JSON.stringify(directionsData)}
    Keep it casual and helpful, matching the advice to the journey length.
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
    
    Example style:
    "Just a heads up about your route - there's some construction work happening on Lekki-Epe Expressway 
    right now. They've closed one lane, so it's moving a bit slow. If you can, I'd recommend taking the 
    alternative route through Admiralty Way. It might be a bit longer, but you'll avoid all that construction 
    hassle."
    
    Keep it natural and helpful, like you're sharing local knowledge with a friend.
    `;

    const result = await model.generateContent(prompt);
    return result.response.text();
}

async function getDirections(req, res) {
    try {
        const { query } = req.body;
        if (!query) {
            return res.status(400).json({ error: 'Query is required' });
        }

        // First, classify the query
        const queryType = await classifyQuery(query);
        console.log('Query type:', queryType);

        // Extract locations and mode
        const { origin, destination, mode, modeConfig } = await extractLocationsAndMode(query);

        // Get directions data with traffic info
        const params = {
            origin,
            destination,
            key: process.env.GOOGLE_MAPS_API_KEY,
            ...modeConfig,
            departure_time: 'now',
            alternatives: true,
            traffic_model: 'best_guess'
        };

        try {
            const directionsResponse = await mapsClient.directions({ params });
            
            if (!directionsResponse.data || directionsResponse.data.status !== 'OK') {
                throw new Error(`Invalid response: ${directionsResponse.data?.status}`);
            }

            // Prepare the base data
            const responseData = {
                ...directionsResponse.data,
                mode,
                current_time: new Date().toLocaleTimeString(),
                traffic_info: {
                    has_traffic: true,
                    routes: directionsResponse.data.routes.map(route => ({
                        normal_duration: route.legs?.[0]?.duration?.text,
                        traffic_duration: route.legs?.[0]?.duration_in_traffic?.text,
                        traffic_status: getTrafficStatus(
                            route.legs?.[0]?.duration?.value,
                            route.legs?.[0]?.duration_in_traffic?.value
                        ),
                        warnings: route.warnings || []
                    }))
                }
            };

            // Format response based on query type
            let formattedResponse;
            switch (queryType) {
                case 'traffic_check':
                    formattedResponse = await formatTrafficCheck(responseData, origin, destination);
                    break;
                case 'duration_check':
                    formattedResponse = await formatDurationCheck(responseData, origin, destination);
                    break;
                case 'route_status':
                    formattedResponse = await formatRouteStatus(responseData, origin, destination);
                    break;
                default:
                    formattedResponse = await formatDirections(responseData);
            }

            res.json({ response: formattedResponse, query_type: queryType });
        } catch (mapsError) {
            console.error('Google Maps API Error:', {
                message: mapsError.message,
                response: mapsError.response?.data,
                status: mapsError.response?.status,
                params: { ...params, key: 'HIDDEN' }
            });

            // Return appropriate error message based on the error
            if (mapsError.response?.status === 404) {
                return res.status(404).json({ 
                    error: 'Route not found',
                    details: 'Could not find a valid route between the specified locations'
                });
            }

            throw new Error(`Google Maps API error: ${mapsError.message}`);
        }
    } catch (error) {
        console.error('Detailed error:', error);
        res.status(500).json({ 
            error: 'Internal server error', 
            details: error.message 
        });
    }
}

// Helper function to determine traffic status
function getTrafficStatus(normalDuration, trafficDuration) {
    if (!normalDuration || !trafficDuration) return 'Unknown';
    
    const difference = trafficDuration - normalDuration;
    const percentageIncrease = (difference / normalDuration) * 100;
    
    if (percentageIncrease <= 10) return 'Light traffic';
    if (percentageIncrease <= 30) return 'Moderate traffic';
    if (percentageIncrease <= 50) return 'Heavy traffic';
    return 'Severe traffic';
}

module.exports = {
    getDirections 
}; 


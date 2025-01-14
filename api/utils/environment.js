const dotenv = require('dotenv');
const path = require('path');

function loadEnvironment() {
    const envPath = path.resolve(process.cwd(), '.env');
    const result = dotenv.config({ path: envPath });
    
    console.log('Loading .env file from:', envPath);
    
    if (result.error) {
        console.error('Error loading .env file:', result.error);
        return false;
    }
    
    const requiredVars = ['GEMINI_API_KEY', 'GOOGLE_MAPS_API_KEY'];
    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
        console.error('Missing required environment variables:', missingVars);
        return false;
    }
    
    return true;
}

module.exports = { loadEnvironment }; 
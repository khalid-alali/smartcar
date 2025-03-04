const express = require('express');
const cors = require('cors');
const { Client } = require('pg');
const smartcar = require('smartcar');
const cookieParser = require('cookie-parser');

// Initialize Express app
const app = express();
const port = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// PostgreSQL Database Connection
const db = new Client({
    connectionString: process.env.DATABASE_URL,
});

// Connect to database
db.connect()
    .then(() => console.log("✅ Connected to PostgreSQL"))
    .catch(err => console.error("❌ Database connection error:", err));

// Smartcar Authentication Client
const client = new smartcar.AuthClient({
    clientId: process.env.SMARTCAR_CLIENT_ID,
    clientSecret: process.env.SMARTCAR_CLIENT_SECRET,
    redirectUri: process.env.SMARTCAR_REDIRECT_URI,
    mode: process.env.SMARTCAR_MODE || 'simulated', // 'live' or 'simulated'
});

app.get('/exchange', async (req, res) => {
    try {
        console.log("🔄 Received Smartcar callback request...");

        const { code } = req.query;
        if (!code) {
            console.log("❌ Missing authorization code");
            return res.status(400).json({ error: "Missing authorization code" });
        }

        // Exchange code for access token
        const access = await client.exchangeCode(code);
        console.log("✅ Smartcar token received:", {
            accessToken: !!access.accessToken ? '✓' : '✗',
            refreshToken: !!access.refreshToken ? '✓' : '✗'
        });

        // If Smartcar session expired
        if (!access.accessToken) {
            console.log("❌ Smartcar session expired or invalid");
            return res.status(401).json({ error: "Session expired. Please log in again." });
        }

        // Extract token details
        const { accessToken, refreshToken, expiration } = access;

        // Get vehicle information
        const vehicleResponse = await smartcar.getVehicles(accessToken);
        console.log("🚗 Vehicle response from Smartcar:", vehicleResponse);

        if (!vehicleResponse.vehicles || !vehicleResponse.vehicles.length) {
            console.log("❌ No vehicles returned from Smartcar.");
            return res.status(400).json({ error: "No vehicles found." });
        }

        const vehicleId = vehicleResponse.vehicles[0];
        console.log(`✅ Storing vehicle ${vehicleId} in database...`);

        // Store the token in the database
        const result = await db.query(
            `INSERT INTO vehicles 
            (vehicle_id, access_token, refresh_token, expires_at) 
            VALUES ($1, $2, $3, $4) 
            ON CONFLICT (vehicle_id) DO UPDATE 
            SET access_token = $2, 
                refresh_token = $3, 
                expires_at = $4 
            RETURNING *`,
            [
                vehicleId, 
                accessToken, 
                refreshToken, 
                new Date(Date.now() + 7200000) // 2 hours from now
            ]
        );

        console.log("✅ Database insert successful:", result.rows[0]);

        // Return success response
        return res.json({ 
            message: "Successfully connected vehicle", 
            vehicleId, 
            accessToken 
        });

    } catch (error) {
        console.error("❌ Error in exchange route:", error.response?.data || error);
        res.status(500).json({ 
            error: "Failed to exchange token or store data",
            details: error.message 
        });
    }
});

// Token Refresh Route
app.post('/refresh-token', async (req, res) => {
    try {
        const { vehicleId } = req.body;

        // Retrieve stored refresh token from database
        const tokenResult = await db.query(
            'SELECT refresh_token FROM vehicle WHERE vehicle_id = $1',
            [vehicleId]
        );

        if (tokenResult.rows.length === 0) {
            return res.status(404).json({ error: "Vehicle not found" });
        }

        const refreshToken = tokenResult.rows[0].refresh_token;

        // Exchange refresh token
        const access = await client.exchangeRefreshToken(refreshToken);

        // Update database with new tokens
        await db.query(
            `UPDATE vehicles 
            SET access_token = $1, 
                refresh_token = $2, 
                expires_at = $3 
            WHERE vehicle_id = $4`,
            [
                access.accessToken, 
                access.refreshToken, 
                new Date(Date.now() + 7200000), // 2 hours from now
                vehicleId
            ]
        );

        res.json({ 
            message: "Token refreshed successfully",
            accessToken: access.accessToken 
        });

    } catch (error) {
        console.error("❌ Token refresh error:", error);
        res.status(500).json({ 
            error: "Failed to refresh token",
            details: error.message 
        });
    }
});

// Error Handling Middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ 
        error: "Something went wrong!", 
        details: err.message 
    });
});

// Start Server
app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    db.end()
        .then(() => console.log('Database connection closed'))
        .catch(console.error)
        .finally(() => process.exit(0));
});

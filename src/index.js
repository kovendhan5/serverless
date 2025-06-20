const functions = require('@google-cloud/functions-framework');
const cors = require('cors');
const helmet = require('helmet');
const express = require('express');
const {validateContactForm} = require('./validation');
const {saveContactSubmission} = require('./database');
const {sendEmails} = require('./email');
const {createResponse, logRequest} = require('./utils');

// Create Express app
const app = express();

// Security middleware
app.use(helmet());

// CORS configuration - Enhanced for better compatibility
const corsOptions = {
  origin: true, // Allow all origins
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'Accept', 
    'X-Requested-With',
    'Origin',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers'
  ],
  credentials: false,
  optionsSuccessStatus: 200, // Some legacy browsers choke on 204
  maxAge: 86400 // Cache preflight for 24 hours
};

// Apply CORS to all routes
app.use(cors(corsOptions));

// Handle preflight requests explicitly
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With, Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
  res.header('Access-Control-Max-Age', '86400');
  res.status(200).end();
});

// Additional CORS headers middleware for maximum compatibility
app.use((req, res, next) => {
  // Set CORS headers on every response
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With, Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
  res.header('Access-Control-Max-Age', '86400');
  
  // Log the request for debugging
  console.log(`${req.method} ${req.path} - Origin: ${req.get('Origin') || 'none'}`);
  
  next();
});

// Body parsing middleware
app.use(express.json({limit: '10mb'}));
app.use(express.urlencoded({extended: true, limit: '10mb'}));

// Rate limiting storage (in-memory for simplicity)
const rateLimitStore = new Map();

// Rate limiting middleware
const rateLimit = (req, res, next) => {
  const clientIP = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxRequests = 5; // Max 5 requests per window

  if (!rateLimitStore.has(clientIP)) {
    rateLimitStore.set(clientIP, []);
  }

  const requests = rateLimitStore.get(clientIP);
  // Clean old requests
  const recentRequests = requests.filter((time) => now - time < windowMs);

  if (recentRequests.length >= maxRequests) {
    return res.status(429).json(createResponse(false, 'Too many requests. Please try again later.'));
  }

  recentRequests.push(now);
  rateLimitStore.set(clientIP, recentRequests);
  next();
};

// Main contact form handler
app.post('/contact', rateLimit, async (req, res) => {
  try {
    // Log the request
    logRequest(req);

    // Validate input
    const validation = validateContactForm(req.body);
    if (!validation.isValid) {
      return res.status(400).json(createResponse(false, 'Validation failed', validation.errors));
    }

    const contactData = validation.data;

    // Add metadata
    const submission = {
      ...contactData,
      timestamp: new Date().toISOString(),
      metadata: {
        ip_address: req.ip || req.connection.remoteAddress,
        user_agent: req.get('User-Agent') || 'Unknown',
        source: 'api',
      },
      status: 'new',
    };

    // Save to Firestore
    const documentId = await saveContactSubmission(submission); // Send emails
    try {
      await sendEmails(contactData, documentId);
    } catch (emailError) {
      // Log email error but don't fail the request
      console.error('Email sending failed:', emailError);
    }

    // Return success response
    res.status(200).json(createResponse(
      true,
      'Thank you for your message. We\'ll get back to you soon!',
      null,
      {id: documentId},
    ));
  } catch (error) {
    console.error('Error processing contact form:', error);
    res.status(500).json(createResponse(false, 'Internal server error. Please try again later.'));
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
  });
});

// Handle 404
app.use('*', (req, res) => {
  res.status(404).json(createResponse(false, 'Endpoint not found'));
});

// Error handling middleware
app.use((error, req, res, _next) => {
  console.error('Unhandled error:', error);
  res.status(500).json(createResponse(false, 'Internal server error'));
});

// Register the function
functions.http('contactFormHandler', app);

// Export for testing
module.exports = {
  app,
  rateLimitStore,
  clearRateLimit: () => rateLimitStore.clear(),
};

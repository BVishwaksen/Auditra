# Auditra

A Chrome extension for real-time audio transcription powered by Google Gemini AI.

## Prerequisites

- Node.js (v16 or later)
- npm (Node Package Manager)
- Google Cloud Account with Generative AI API enabled
- Chrome Browser (latest)

## Project Structure

The repository contains two main folders:

- **Backend** - Server responsible for audio transcription that interacts with Gemini AI
- **Extension** - Chrome extension (frontend) that captures audio and displays transcripts

### Architecture Flow
1. Chrome extension captures audio chunks from browser tabs
2. Extension sends audio data to the backend server (Node + Express)
3. Backend server processes audio using Gemini AI for transcription
4. Transcribed text is sent back to the extension for display

## Setup Instructions

### 1. Clone the Repository

```bash
git clone https://github.com/YOUR_USERNAME/auditra.git
cd auditra
```

### 2. Backend Setup

```bash
# Navigate to backend directory
cd Backend

# Install dependencies
npm install

# Create environment file
touch .env
```

Add the following content to the `.env` file:

```env
GEMINI_API_KEY=<<your_google_gemini_api_key_here>>
PORT=3000
```

Start the backend server:

```bash
node server.js
```

The server will start on `http://localhost:3000`.

### 3. Extension Setup

```bash
# Navigate to extension directory
cd ../Extension

# Install dependencies
npm install

# Build the extension
npm run build
```

### 4. Load Extension in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer Mode** (toggle in top right)
3. Click **Load Unpacked**
4. Select the `build` folder from the Extension directory
5. The extension will appear in your extensions list

## API Key Configuration

### Getting Your API Key

1. Go to [Google AI Studio](https://aistudio.google.com/)
2. Generate a Gemini API key
3. Copy the API key

### Security Note

⚠️ **Never hardcode the API key in the frontend (React)**. Always load from backend environment variables for security.

## Vercel Deployment

The backend is configured for Vercel deployment with `module.exports = app`.

### Environment Variables in Vercel

1. Go to your Vercel project dashboard
2. Navigate to **Settings → Environment Variables**
3. Add `GEMINI_API_KEY` with your API key value
4. Redeploy the backend

## Testing the Setup

1. Start the backend server:
   ```bash
   cd Backend
   npm start
   ```

2. Open the Chrome extension popup

3. Select a tab (e.g., Google Meet, YouTube) and click **Record**

4. Speak into the microphone if enabled

5. Check if transcripts appear in real-time

## Usage

Once setup is complete, you can:

- Record audio from any Chrome tab
- Get real-time transcription powered by Google Gemini AI
- Use the extension on popular platforms like Google Meet, YouTube, etc.

## Development

### Backend Development
- The backend runs on Express.js
- Audio processing is handled through Gemini AI API
- Environment variables are loaded from `.env` file

### Extension Development
- Built with React
- Uses Chrome Extension APIs for tab audio capture
- Communicates with backend via HTTP requests


---

**You are now ready to use the Chrome Extension with real-time transcription powered by Google Gemini AI!**
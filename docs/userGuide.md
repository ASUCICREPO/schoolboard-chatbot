# User Guide

Step-by-step usage instructions for The Beam School Board AI.

---

## Public Chatbot

### Browsing Districts

1. Visit the landing page to see all available school districts
2. Each district card shows the number of indexed transcripts and the last update date
3. Use the search bar to filter districts by name
4. Click a district to open its chatbot

### Asking Questions

1. Type your question in the text box at the bottom of the chat
2. Press Enter or click Send
3. The AI will search through indexed meeting transcripts and provide an answer
4. Answers include citations showing which transcript excerpts were used
5. Use suggested questions for quick starting points

### Tips for Better Answers

- Be specific: "What budget items were approved at the March meeting?" works better than "Tell me about the budget"
- The AI only knows what's in the transcripts — if a meeting hasn't been uploaded, it can't answer about it
- If the AI says "I don't have information," the transcript for that topic may not be uploaded yet
- Multi-turn conversations are supported — ask follow-up questions in the same session

---

## Admin Dashboard

Access the admin dashboard at `/admin`. You must log in with your Cognito credentials.

### Logging In

1. Navigate to `/admin`
2. Enter your username and password
3. Click "Sign In"
4. Your session lasts 1 hour — refresh the page to re-authenticate

### Districts Tab

**Viewing Districts**
- All districts are listed alphabetically with their YouTube URL and status
- Use the search bar to filter by name or ID

**Adding a District**
1. Click "+ Add District"
2. Fill in the ID (optional — auto-generated from name), name, and YouTube URL
3. Click "Create District"

**Editing a District**
1. Click "Edit" on any district
2. Modify the name or YouTube URL
3. Click "Save"

**Deleting a District**
1. Click "Delete" on any district
2. Confirm the deletion

### New Videos Tab

**Scanning for Videos**
1. Click "Scan YouTube Channels"
2. Wait for the scan to complete (takes 15-30 seconds for all districts)
3. A success message shows how many new videos were found
4. The scan runs automatically every 6 hours via EventBridge

**Viewing Discovered Videos**
- Videos are grouped by district, sorted alphabetically
- Each video shows a thumbnail, title, publish date, and YouTube link
- Use the search bar to filter by district name

**Uploading a Transcript**

Option 1 — Paste text:
1. Click "Paste Transcript" on a video
2. Paste the full transcript text in the modal
3. The character count is shown — there is no limit
4. Click "Upload Transcript"

Option 2 — Upload audio/video:
1. Click "Upload Audio/Video" on a video
2. Select an audio or video file (mp3, mp4, wav, webm, m4a, etc.)
3. The file uploads to S3 and AWS Transcribe processes it automatically
4. Processing takes a few minutes depending on file length
5. The transcript appears in the Transcripts tab when complete

### Transcripts Tab

**Viewing Transcripts**
- Transcripts are grouped by district, sorted alphabetically
- Each shows the title, date, source (manual or Transcribe), and character count
- Use the search bar to filter by district or title

**Reading a Transcript**
1. Click "View" on any completed transcript
2. The full text opens in a scrollable modal
3. Click "Close" to dismiss

**Deleting a Transcript**
1. Click "Delete" on any transcript
2. Confirm the deletion
3. The S3 file is removed and the Knowledge Base re-syncs automatically
4. The chatbot will no longer reference the deleted transcript (after ~60 seconds)

### Analytics Tab

The analytics tab shows usage data from the chatbot:

- **Total Queries** — Number of questions asked across all districts
- **Answer Rate** — Percentage of queries that received a substantive answer
- **Unique Sessions** — Number of distinct chat sessions
- **Avg Answer Length** — Average character count of AI responses
- **Queries Per Day** — Bar chart showing daily query volume
- **Most Queried Districts** — Ranked bar chart of which districts get the most questions
- **Top Concerns** — Queries categorized by topic (Budget, Safety, Staffing, etc.) with example questions

---

## Workflow: Adding a New Meeting Transcript

The typical workflow for adding a new board meeting transcript:

1. **Automatic**: The YouTube monitor discovers the video and it appears in the New Videos tab
2. **Watch**: Click the YouTube link to watch the meeting
3. **Choose upload method**:
   - If you have a text transcript (from YouTube captions, a court reporter, etc.), use "Paste Transcript"
   - If you only have the audio/video file, use "Upload Audio/Video" to let AWS Transcribe process it
4. **Verify**: Check the Transcripts tab to confirm the transcript was stored
5. **Test**: Ask a question in the district's chatbot to verify it's indexed
6. **Note**: KB ingestion takes 30-60 seconds after upload. If the chatbot doesn't find the new transcript immediately, wait a minute and try again.

School Board Chatbot Technical Documentation
Transcript Ingestion & Admin Management System
A serverless AI-powered platform that enables school districts to upload, manage, and query board meeting transcripts. The system supports manual transcript ingestion (text, audio, video) and uses AWS Bedrock Knowledge Base to power a chatbot for answering user questions.
This solution is designed to improve transparency and accessibility of school board discussions while remaining cost-effective and scalable.

 Overview
  This project provides:
A chatbot interface for querying school board transcripts
An admin dashboard for managing transcripts and districts
A backend pipeline for transcript ingestion and processing
Query logging for analytics and insights
  The system is optimized for:
Low operational cost (serverless architecture)
Simplicity (POC-friendly design)
Future extensibility (automation-ready)

High Level Architecture
     The system follows a serverless architecture using AWS services:
Amazon S3 → Stores transcripts and uploaded media
Amazon DynamoDB → Stores metadata and query logs
AWS Lambda → Handles APIs and processing
API Gateway → Exposes backend endpoints
Amazon Bedrock Knowledge Base → Enables RAG-based chatbot
Amazon Cognito → Handles admin authentication
Next.js Frontend → UI for chatbot and admin dashboard

Data Flow
Admin → API Gateway → Lambda (admin-api)
    → S3 (transcripts/uploads)
    → DynamoDB (metadata/logs)
    → Bedrock KB (indexing)

User → Chatbot API → Bedrock KB → Response

Features
1. Transcript Management
Upload transcript text
Upload audio/video files (auto transcription via AWS Transcribe)
View transcript content
Delete transcripts
Automatic rolling window (max 3 transcripts per district)

2. Admin Dashboard
Accessible via /admin
Admins can:
Manage transcripts
View transcript repository
Monitor user queries
Manage districts

3. Query Logging & Analytics
Stores anonymized queries
Tracks usage patterns
Provides aggregated insights (query volume, top districts)

API Overview
Transcript APIs
POST /admin/transcripts        → Upload transcript text
POST /admin/upload             → Generate presigned upload URL
GET  /admin/transcripts        → List transcripts
DELETE /admin/transcripts      → Delete transcript

Query APIs
GET /admin/query-logs          → Retrieve query logs
GET /admin/query-logs/stats    → Retrieve analytics

Backend Design
Lambda Functions
     admin-api
Handles admin routes
Manages transcripts and districts
Retrieves query logs

    transcript-processor
Triggered by S3 uploads
Transcribes audio/video using AWS Transcribe
Stores output in S3
Triggers Bedrock KB sync

Database (DynamoDB)
schoolbot-transcripts
Stores transcript metadata
schoolbot-districts
Stores district information
schoolbot-query-logs
Stores anonymized user queries

Frontend
Built with Next.js
Key Features
Admin dashboard UI
Chat interface
Cognito-based authentication

Environment Setup
Create .env.local:
NEXT_PUBLIC_API_URL=
NEXT_PUBLIC_USER_POOL_ID=
NEXT_PUBLIC_USER_POOL_CLIENT_ID=

Deployment Guide
Prerequisites
AWS CLI configured
Node.js installed
AWS CDK installed

1. Bootstrap AWS CDK
cdk bootstrap

2. Install Dependencies
cd cdk
npm install

cd lambda/admin-api && npm install
cd ../chatbot-api && npm install
cd ../transcript-processor && npm install

3. Deploy Infrastructure
cdk deploy

4. Get API URL
aws cloudformation describe-stacks \
--stack-name SchoolbotStack \
--query "Stacks[0].Outputs"

5. Run Frontend
cd frontend
npm install
npm run dev
Visit:
http://localhost:3000/admin

Common Issues
CDK Deployment Fails
Run:
cdk synth
Check CloudFormation logs

S3 Bucket Conflicts
Avoid hardcoded bucket names
Let CDK generate unique names

Stack Stuck (ROLLBACK_FAILED / DELETE_FAILED)
Delete stack manually or via CLI

Frontend Cannot Connect to API
Verify .env.local API URL
Restart dev server

Cognito Errors
Ensure UserPoolId and ClientId are set correctly

Design Decisions
Manual Transcript Ingestion
Avoids YouTube API limitations
More reliable for POC

Serverless Architecture
Low cost
Minimal infrastructure
Scales automatically

Rolling Window (3 transcripts)
Controls cost
Keeps chatbot responses relevant

 Future Improvements
Advanced analytics (Athena/OpenSearch)
Role-based access control
Transcript tagging and filtering
Multi-language support

Credits
Developed by:
Lahari Shakthi Arun
Shawn Neill

 License
MIT License

Why this version is better
This version:
Reads like a real engineering doc
Removes clutter and repetition
Keeps sections clear and scannable
Works for GitHub, portfolio, or submission

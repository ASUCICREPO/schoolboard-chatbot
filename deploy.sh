#!/bin/bash
set -e

echo "============================================"
echo "  The Beam - School Board AI Deployment"
echo "============================================"
echo ""

# ── Detect OS ─────────────────────────────────────────────────────────────────

OS="unknown"
case "$(uname -s)" in
  Darwin*) OS="mac" ;;
  Linux*)  OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
esac
echo "Detected OS: $OS"
echo ""

# ── Check prerequisites ──────────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js is required. Install from https://nodejs.org"; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "ERROR: AWS CLI is required. Install from https://aws.amazon.com/cli/"; exit 1; }
command -v cdk >/dev/null 2>&1 || { echo "AWS CDK not found. Installing globally..."; npm install -g aws-cdk; }

echo "[OK] Prerequisites checked"
echo ""

# ── Verify AWS credentials ───────────────────────────────────────────────────

echo "Verifying AWS credentials..."
AWS_ACCOUNT=$(aws sts get-caller-identity --query "Account" --output text 2>/dev/null) || {
  echo "ERROR: AWS credentials not configured. Run:"
  echo "   aws sso login --profile your-profile"
  echo "   export AWS_PROFILE=your-profile"
  exit 1
}
AWS_REGION=${AWS_REGION:-us-west-2}
echo "[OK] AWS Account: $AWS_ACCOUNT"
echo "[OK] AWS Region:  $AWS_REGION"
echo ""

# ── Check for YouTube API key ────────────────────────────────────────────────

if [ ! -f cdk/.env ]; then
  echo "No cdk/.env file found."
  printf "Enter your YouTube Data API v3 key (or press Enter to skip): "
  read YT_KEY
  if [ -n "$YT_KEY" ]; then
    printf "YOUTUBE_API_KEY=%s\n" "$YT_KEY" > cdk/.env
    echo "[OK] Saved YouTube API key to cdk/.env"
  else
    printf "YOUTUBE_API_KEY=\n" > cdk/.env
    echo "[WARN] YouTube monitoring will not work without an API key"
  fi
else
  echo "[OK] cdk/.env exists"
fi
echo ""

# ── Install CDK dependencies ─────────────────────────────────────────────────

echo "Installing CDK dependencies..."
cd cdk
npm install --silent
echo "[OK] CDK dependencies installed"
echo ""

# ── Bootstrap CDK (if needed) ────────────────────────────────────────────────

echo "Checking CDK bootstrap..."
cdk bootstrap "aws://$AWS_ACCOUNT/$AWS_REGION" 2>/dev/null || true
echo "[OK] CDK bootstrapped"
echo ""

# ── Deploy the stack ─────────────────────────────────────────────────────────

echo "Deploying SchoolbotStack..."
echo ""
cdk deploy --require-approval never --outputs-file ../cdk-outputs.json

echo ""
echo "[OK] Stack deployed successfully"
echo ""

# ── Extract outputs ──────────────────────────────────────────────────────────

API_URL=$(node -e "const o=require('../cdk-outputs.json');console.log(o.SchoolbotStack.ApiUrl)")
USER_POOL_ID=$(node -e "const o=require('../cdk-outputs.json');console.log(o.SchoolbotStack.UserPoolId)")
CLIENT_ID=$(node -e "const o=require('../cdk-outputs.json');console.log(o.SchoolbotStack.UserPoolClientId)")

echo "Stack Outputs:"
echo "  API URL:        $API_URL"
echo "  User Pool ID:   $USER_POOL_ID"
echo "  Client ID:      $CLIENT_ID"
echo ""

# ── Create admin user ────────────────────────────────────────────────────────

echo "Setting up admin user..."
printf "Create an admin user? (y/n): "
read CREATE_ADMIN
if [ "$CREATE_ADMIN" = "y" ] || [ "$CREATE_ADMIN" = "Y" ]; then
  printf "  Admin username: "
  read ADMIN_USER

  # Read password (hide input on supported systems)
  if [ "$OS" = "windows" ]; then
    printf "  Admin password: "
    read ADMIN_PASS
  else
    printf "  Admin password: "
    stty -echo 2>/dev/null || true
    read ADMIN_PASS
    stty echo 2>/dev/null || true
    echo ""
  fi

  aws cognito-idp admin-create-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$ADMIN_USER" \
    --temporary-password "TempPass123!" \
    --message-action SUPPRESS \
    --region "$AWS_REGION" >/dev/null 2>&1 || true

  aws cognito-idp admin-set-user-password \
    --user-pool-id "$USER_POOL_ID" \
    --username "$ADMIN_USER" \
    --password "$ADMIN_PASS" \
    --permanent \
    --region "$AWS_REGION" >/dev/null 2>&1

  echo "[OK] Admin user '$ADMIN_USER' created"
else
  echo "[SKIP] Skipping admin user creation"
fi
echo ""

# ── Seed districts by triggering YouTube monitor ─────────────────────────────

echo "Seeding districts..."
MONITOR_FN=$(node -e "
const cf = require('child_process');
const out = cf.execSync('aws cloudformation describe-stack-resources --stack-name SchoolbotStack --logical-resource-id YoutubeMonitorFn4AFA596C --region $AWS_REGION --query \"StackResources[0].PhysicalResourceId\" --output text', {encoding:'utf8'}).trim();
console.log(out);
" 2>/dev/null) || true

if [ -n "$MONITOR_FN" ]; then
  aws lambda invoke --function-name "$MONITOR_FN" --payload '{}' --cli-binary-format raw-in-base64-out --region "$AWS_REGION" /dev/null >/dev/null 2>&1 || true
  echo "[OK] Districts seeded"
else
  echo "[WARN] Could not find monitor function — run 'Scan YouTube Channels' from the admin dashboard"
fi
echo ""

# ── Build and deploy frontend to Amplify ─────────────────────────────────────

echo "Building and deploying frontend to Amplify..."
cd ../frontend
npm install --silent

# Write env file with CDK outputs
printf "NEXT_PUBLIC_API_URL=%s\n" "$API_URL" > .env
printf "NEXT_PUBLIC_COGNITO_USER_POOL_ID=%s\n" "$USER_POOL_ID" >> .env
printf "NEXT_PUBLIC_COGNITO_CLIENT_ID=%s\n" "$CLIENT_ID" >> .env

# Build the static site
echo "Building Next.js..."
npm run build

# Check if Amplify app already exists
AMPLIFY_APP_ID=$(aws amplify list-apps --region "$AWS_REGION" --query "apps[?name=='schoolbot-beam'].appId" --output text 2>/dev/null)

if [ -z "$AMPLIFY_APP_ID" ] || [ "$AMPLIFY_APP_ID" = "None" ]; then
  echo "Creating Amplify app..."
  AMPLIFY_APP_ID=$(aws amplify create-app \
    --name "schoolbot-beam" \
    --region "$AWS_REGION" \
    --query "app.appId" \
    --output text)
  echo "[OK] Amplify app created: $AMPLIFY_APP_ID"

  aws amplify create-branch \
    --app-id "$AMPLIFY_APP_ID" \
    --branch-name main \
    --region "$AWS_REGION" >/dev/null
  echo "[OK] Branch 'main' created"
else
  echo "[OK] Amplify app exists: $AMPLIFY_APP_ID"
fi

# Zip the contents of out/ (files at zip root, not inside an out/ folder)
echo "Packaging build..."
rm -f build.zip
if command -v zip >/dev/null 2>&1; then
  cd out && zip -r ../build.zip . -q && cd ..
else
  OUTDIR=$(cd out && pwd -W 2>/dev/null || pwd)
  ZIPPATH=$(cd . && pwd -W 2>/dev/null || pwd)/build.zip
  cat > _zip_tmp.ps1 << ENDPS
Add-Type -Assembly System.IO.Compression.FileSystem
\$outDir = "$OUTDIR"
\$zipPath = "$ZIPPATH"
if (Test-Path \$zipPath) { Remove-Item \$zipPath }
\$zip = [System.IO.Compression.ZipFile]::Open(\$zipPath, "Create")
Get-ChildItem -Path \$outDir -Recurse -File | ForEach-Object {
  \$rel = \$_.FullName.Substring(\$outDir.Length + 1).Replace("\", "/")
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(\$zip, \$_.FullName, \$rel) | Out-Null
}
\$zip.Dispose()
ENDPS
  powershell -ExecutionPolicy Bypass -File _zip_tmp.ps1
  rm -f _zip_tmp.ps1
fi
echo "[OK] Build packaged"

# Deploy to Amplify (single create-deployment call)
echo "Uploading to Amplify..."
DEPLOY_RESULT=$(aws amplify create-deployment \
  --app-id "$AMPLIFY_APP_ID" \
  --branch-name main \
  --region "$AWS_REGION" \
  --output json)

DEPLOY_URL=$(echo "$DEPLOY_RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).zipUploadUrl))")
JOB_ID=$(echo "$DEPLOY_RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).jobId))")

# Upload the zip (use curl or powershell)
if command -v curl >/dev/null 2>&1; then
  curl -s -T build.zip "$DEPLOY_URL"
elif [ "$OS" = "windows" ]; then
  powershell -Command "Invoke-RestMethod -Method Put -Uri '$DEPLOY_URL' -InFile 'build.zip' -ContentType 'application/zip'"
else
  echo "ERROR: 'curl' not found."
  exit 1
fi

# Start the deployment
aws amplify start-deployment \
  --app-id "$AMPLIFY_APP_ID" \
  --branch-name main \
  --job-id "$JOB_ID" \
  --region "$AWS_REGION" >/dev/null

# Clean up
rm -f build.zip

AMPLIFY_URL="https://main.${AMPLIFY_APP_ID}.amplifyapp.com"
echo "[OK] Frontend deployed to Amplify"
echo ""

# ── Done ─────────────────────────────────────────────────────────────────────

echo "============================================"
echo "  Deployment Complete!"
echo "============================================"
echo ""
echo "  API:       $API_URL"
echo "  Frontend:  $AMPLIFY_URL"
echo "  Admin:     ${AMPLIFY_URL}/admin"
echo ""
echo "  Next steps:"
echo "  1. Visit ${AMPLIFY_URL}/admin"
echo "  2. Log in and click 'Scan YouTube Channels'"
echo "  3. Upload transcripts for discovered videos"
echo ""
echo "  To redeploy frontend only:"
echo "    bash deploy-frontend.sh"
echo ""

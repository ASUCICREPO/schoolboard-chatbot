#!/bin/bash
set -e
trap 'echo ""; echo "[ERROR] Script failed at line $LINENO (exit code $?)"; echo "  Last command: $BASH_COMMAND"' ERR

echo "============================================"
echo "  The Beam - School Board AI Deployment"
echo "  (AWS CloudShell Edition)"
echo "============================================"
echo ""

# ── CloudShell Environment Notes ─────────────────────────────────────────────
# CloudShell provides:
#   - AWS CLI v2 (pre-authenticated with console credentials)
#   - Node.js (via nvm)
#   - ~1 GB persistent storage in $HOME
#   - ~1 GB /tmp (non-persistent)
#   - git, zip, curl
#   - No Docker, no sudo for package installs
#
# Constraints handled by this script:
#   - Limited memory: Node heap capped at 460 MB
#   - Limited disk: npm caches in /tmp, node_modules kept lean
#   - Session timeout: script is idempotent and can be re-run safely
# ─────────────────────────────────────────────────────────────────────────────

# ── Use /tmp for caches to save persistent storage ───────────────────────────

export npm_config_cache=/tmp/.npm-cache
export TMPDIR=/tmp

# ── Check Node.js version ────────────────────────────────────────────────────

echo "Checking Node.js..."
NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 18 ]; then
  echo "Node.js 18+ required. Attempting to switch via nvm..."
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 20 2>/dev/null || nvm use 20 2>/dev/null || {
    echo "[ERROR] Could not get Node.js 18+. Run: nvm install 20"
    exit 1
  }
fi
echo "[OK] Node.js $(node --version)"

# ── Install AWS CDK if not present ───────────────────────────────────────────

if ! command -v cdk >/dev/null 2>&1; then
  echo "Installing AWS CDK globally..."
  npm install -g aws-cdk --silent
fi
echo "[OK] CDK $(cdk --version | cut -d' ' -f1)"
echo ""

# ── Verify AWS credentials (CloudShell inherits console session) ─────────────

echo "Verifying AWS credentials..."
AWS_ACCOUNT=$(aws sts get-caller-identity --query "Account" --output text) || {
  echo "[ERROR] AWS credentials not available."
  echo "  CloudShell should auto-authenticate. Try refreshing the session."
  exit 1
}

# CloudShell sets AWS_REGION automatically from the console region
AWS_REGION=${AWS_REGION:-$(aws configure get region 2>/dev/null || echo "")}
if [ -z "$AWS_REGION" ]; then
  # Fallback: try the metadata endpoint (CloudShell-specific)
  AWS_REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo "")
fi
if [ -z "$AWS_REGION" ]; then
  printf "AWS Region (e.g. us-west-2, us-east-1): "
  read AWS_REGION
  if [ -z "$AWS_REGION" ]; then
    echo "[ERROR] Region is required."
    exit 1
  fi
fi
export AWS_REGION
export AWS_DEFAULT_REGION="$AWS_REGION"

echo "[OK] AWS Account: $AWS_ACCOUNT"
echo "[OK] AWS Region:  $AWS_REGION"
echo ""

# ── Check for YouTube API key in Secrets Manager ─────────────────────────────

echo "Checking YouTube API key..."
if aws secretsmanager describe-secret --secret-id "schoolbot/youtube-api-key" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "[OK] YouTube API key found in Secrets Manager"
else
  echo "No YouTube API key found in Secrets Manager."
  printf "Enter your YouTube Data API v3 key (or press Enter to skip): "
  read -r YT_KEY
  if [ -n "$YT_KEY" ]; then
    aws secretsmanager create-secret \
      --name "schoolbot/youtube-api-key" \
      --description "YouTube Data API v3 key for SchoolBot channel monitoring" \
      --secret-string "$YT_KEY" \
      --region "$AWS_REGION" >/dev/null
    echo "[OK] YouTube API key stored in Secrets Manager"
  else
    echo "[WARN] YouTube channel monitoring will not work without an API key"
  fi
fi
echo ""

# ── Install CDK dependencies ─────────────────────────────────────────────────

echo "Installing CDK dependencies..."
cd cdk
npm install
echo "[OK] CDK dependencies installed"
echo ""

# ── Bootstrap CDK (if needed) ────────────────────────────────────────────────

echo "Checking CDK bootstrap..."
cdk bootstrap "aws://$AWS_ACCOUNT/$AWS_REGION" 2>/dev/null || true
echo "[OK] CDK bootstrapped"
echo ""

# ── Deploy the stack ─────────────────────────────────────────────────────────

echo "Deploying SchoolbotStack (this may take 5-10 minutes)..."
echo ""
cdk deploy --require-approval never --outputs-file ../cdk-outputs.json --ci

echo ""
echo "[OK] Stack deployed successfully"
echo ""

# ── Extract outputs ──────────────────────────────────────────────────────────

cd ..
API_URL=$(node -e "const o=require('./cdk-outputs.json');console.log(o.SchoolbotStack.ApiUrl)")
USER_POOL_ID=$(node -e "const o=require('./cdk-outputs.json');console.log(o.SchoolbotStack.UserPoolId)")
CLIENT_ID=$(node -e "const o=require('./cdk-outputs.json');console.log(o.SchoolbotStack.UserPoolClientId)")

echo "Stack Outputs:"
echo "  API URL:        $API_URL"
echo "  User Pool ID:   $USER_POOL_ID"
echo "  Client ID:      $CLIENT_ID"
echo ""

# ── Create admin user ────────────────────────────────────────────────────────

echo "Setting up admin user..."
printf "Create an admin user? (y/n): "
read -r CREATE_ADMIN
if [ "$CREATE_ADMIN" = "y" ] || [ "$CREATE_ADMIN" = "Y" ]; then
  printf "  Admin username: "
  read -r ADMIN_USER
  printf "  Admin password (min 8 chars, upper+lower+number): "
  read -rs ADMIN_PASS
  echo ""

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
    --region "$AWS_REGION" 2>&1 || {
    echo ""
    echo "[ERROR] Password does not meet requirements."
    echo "  Must be at least 8 characters with uppercase, lowercase, and a number."
    echo "  Set it manually later:"
    echo "  aws cognito-idp admin-set-user-password --user-pool-id $USER_POOL_ID --username $ADMIN_USER --password YOUR_PASSWORD --permanent --region $AWS_REGION"
  }

  echo "[OK] Admin user '$ADMIN_USER' created"
else
  echo "[SKIP] Skipping admin user creation"
fi
echo ""

# ── Seed districts by triggering YouTube monitor ─────────────────────────────

echo "Seeding districts..."
MONITOR_FN=$(aws cloudformation describe-stack-resources \
  --stack-name SchoolbotStack \
  --logical-resource-id YoutubeMonitorFn4AFA596C \
  --region "$AWS_REGION" \
  --query "StackResources[0].PhysicalResourceId" \
  --output text 2>/dev/null) || true

if [ -n "$MONITOR_FN" ] && [ "$MONITOR_FN" != "None" ]; then
  aws lambda invoke \
    --function-name "$MONITOR_FN" \
    --payload '{}' \
    --cli-binary-format raw-in-base64-out \
    --region "$AWS_REGION" \
    /tmp/lambda-out.json >/dev/null 2>&1 || true
  echo "[OK] Districts seeded"
else
  echo "[WARN] Could not find monitor function — run 'Scan YouTube Channels' from the admin dashboard"
fi
echo ""

# ── Build and deploy frontend to Amplify ─────────────────────────────────────

echo "Building and deploying frontend to Amplify..."
cd frontend
npm install

# Write env file with CDK outputs
cat > .env <<EOF
NEXT_PUBLIC_API_URL=${API_URL}
NEXT_PUBLIC_COGNITO_USER_POOL_ID=${USER_POOL_ID}
NEXT_PUBLIC_COGNITO_CLIENT_ID=${CLIENT_ID}
EOF

# Build the static site (limit Node heap for CloudShell's ~1GB memory)
echo "Building Next.js (memory-constrained mode)..."
NODE_OPTIONS="--max-old-space-size=460" npm run build

# Check if Amplify app already exists
AMPLIFY_APP_ID=$(aws amplify list-apps --region "$AWS_REGION" \
  --query "apps[?name=='schoolbot-beam'].appId" --output text 2>/dev/null)

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

# Zip the build output (CloudShell has zip available)
echo "Packaging build..."
rm -f /tmp/build.zip
cd out
zip -r /tmp/build.zip . -q
cd ..
echo "[OK] Build packaged"

# Deploy to Amplify
echo "Uploading to Amplify..."
DEPLOY_RESULT=$(aws amplify create-deployment \
  --app-id "$AMPLIFY_APP_ID" \
  --branch-name main \
  --region "$AWS_REGION" \
  --output json)

DEPLOY_URL=$(echo "$DEPLOY_RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).zipUploadUrl))")
JOB_ID=$(echo "$DEPLOY_RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).jobId))")

curl -s --upload-file /tmp/build.zip "$DEPLOY_URL" >/dev/null

aws amplify start-deployment \
  --app-id "$AMPLIFY_APP_ID" \
  --branch-name main \
  --job-id "$JOB_ID" \
  --region "$AWS_REGION" >/dev/null

# Clean up
rm -f /tmp/build.zip

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
echo "  To redeploy frontend only:"
echo "    bash deploy-frontend.sh"
echo ""
echo "  Next steps:"
echo "  1. Visit ${AMPLIFY_URL}"
echo "  2. Log in to Admin and click 'Scan YouTube Channels'"
echo "  3. Upload transcripts for discovered videos"
echo ""

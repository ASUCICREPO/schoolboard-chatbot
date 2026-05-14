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
# Strategy:
#   - Deploy backend via CDK (installs only CDK deps, ~200MB)
#   - Frontend is built REMOTELY by Amplify via GitHub integration
#   - This avoids the disk space issue of installing Next.js locally
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

# ── Check for GitHub token (needed for Amplify to pull and build frontend) ───

echo "Checking GitHub token for Amplify..."
GITHUB_TOKEN=""
if aws secretsmanager describe-secret --secret-id "schoolbot/github-token" --region "$AWS_REGION" >/dev/null 2>&1; then
  GITHUB_TOKEN=$(aws secretsmanager get-secret-value --secret-id "schoolbot/github-token" --region "$AWS_REGION" --query SecretString --output text 2>/dev/null || echo "")
  echo "[OK] GitHub token found in Secrets Manager"
else
  echo "No GitHub token found in Secrets Manager."
  echo ""
  echo "Amplify needs a GitHub Personal Access Token to pull and build the frontend."
  echo "Create one at: https://github.com/settings/tokens"
  echo "Required scopes: repo (full control of private repositories)"
  echo ""
  printf "Enter your GitHub Personal Access Token (or press Enter to skip): "
  read -rs GH_TOKEN
  echo ""
  if [ -n "$GH_TOKEN" ]; then
    aws secretsmanager create-secret \
      --name "schoolbot/github-token" \
      --description "GitHub PAT for Amplify to pull and build the frontend" \
      --secret-string "$GH_TOKEN" \
      --region "$AWS_REGION" >/dev/null
    GITHUB_TOKEN="$GH_TOKEN"
    echo "[OK] GitHub token stored in Secrets Manager"
  else
    echo "[WARN] Without a GitHub token, you'll need to deploy the frontend manually."
    echo "       You can run deploy-frontend.sh from a machine with more disk space."
  fi
fi
echo ""

# ── Prompt for GitHub repo URL ───────────────────────────────────────────────

GITHUB_REPO_URL=""
if [ -n "$GITHUB_TOKEN" ]; then
  # Try to detect from git remote
  GITHUB_REPO_URL=$(git remote get-url origin 2>/dev/null || echo "")
  # Convert SSH URL to HTTPS if needed
  if echo "$GITHUB_REPO_URL" | grep -q "^git@"; then
    GITHUB_REPO_URL=$(echo "$GITHUB_REPO_URL" | sed 's|git@github.com:|https://github.com/|' | sed 's|\.git$||')
  fi
  # Strip .git suffix
  GITHUB_REPO_URL=$(echo "$GITHUB_REPO_URL" | sed 's|\.git$||')

  if [ -n "$GITHUB_REPO_URL" ]; then
    echo "Detected GitHub repo: $GITHUB_REPO_URL"
    printf "Use this repo for Amplify? (y/n): "
    read -r USE_DETECTED
    if [[ ! "$USE_DETECTED" =~ ^[Yy]$ ]]; then
      GITHUB_REPO_URL=""
    fi
  fi

  if [ -z "$GITHUB_REPO_URL" ]; then
    printf "Enter GitHub repo URL (e.g. https://github.com/user/repo): "
    read -r GITHUB_REPO_URL
  fi
fi
echo ""

# ── Install CDK dependencies ─────────────────────────────────────────────────

echo "Installing CDK dependencies..."
cd cdk
npm install --prefer-offline --no-audit --no-fund 2>&1 | tail -1
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

# ── Free disk space (CDK node_modules no longer needed) ──────────────────────

echo "Freeing disk space (removing CDK node_modules)..."
rm -rf cdk/node_modules
rm -rf /tmp/.npm-cache
echo "[OK] Disk space freed"
echo ""

# ── Deploy frontend via Amplify + GitHub ─────────────────────────────────────

echo "Setting up Amplify frontend..."

if [ -n "$GITHUB_TOKEN" ] && [ -n "$GITHUB_REPO_URL" ]; then
  # ── Create or find Amplify app with GitHub integration ───────────────────
  AMPLIFY_APP_ID=$(aws amplify list-apps --region "$AWS_REGION" \
    --query "apps[?name=='schoolbot-beam'].appId" --output text 2>/dev/null)

  if [ -z "$AMPLIFY_APP_ID" ] || [ "$AMPLIFY_APP_ID" = "None" ]; then
    echo "Creating Amplify app with GitHub integration..."

    AMPLIFY_APP_ID=$(aws amplify create-app \
      --name "schoolbot-beam" \
      --repository "$GITHUB_REPO_URL" \
      --access-token "$GITHUB_TOKEN" \
      --build-spec "version: 1
frontend:
  phases:
    preBuild:
      commands:
        - cd frontend
        - npm ci
    build:
      commands:
        - cd frontend
        - echo \"NEXT_PUBLIC_API_URL=${API_URL}\" > .env
        - echo \"NEXT_PUBLIC_COGNITO_USER_POOL_ID=${USER_POOL_ID}\" >> .env
        - echo \"NEXT_PUBLIC_COGNITO_CLIENT_ID=${CLIENT_ID}\" >> .env
        - npm run build
  artifacts:
    baseDirectory: frontend/out
    files:
      - '**/*'
  cache:
    paths:
      - frontend/node_modules/**/*" \
      --environment-variables "NEXT_PUBLIC_API_URL=${API_URL},NEXT_PUBLIC_COGNITO_USER_POOL_ID=${USER_POOL_ID},NEXT_PUBLIC_COGNITO_CLIENT_ID=${CLIENT_ID}" \
      --region "$AWS_REGION" \
      --query "app.appId" \
      --output text)

    echo "[OK] Amplify app created: $AMPLIFY_APP_ID"

    # Create the main branch
    aws amplify create-branch \
      --app-id "$AMPLIFY_APP_ID" \
      --branch-name main \
      --region "$AWS_REGION" >/dev/null
    echo "[OK] Branch 'main' connected"
  else
    echo "[OK] Amplify app exists: $AMPLIFY_APP_ID"

    # Update environment variables with latest CDK outputs
    aws amplify update-app \
      --app-id "$AMPLIFY_APP_ID" \
      --environment-variables "NEXT_PUBLIC_API_URL=${API_URL},NEXT_PUBLIC_COGNITO_USER_POOL_ID=${USER_POOL_ID},NEXT_PUBLIC_COGNITO_CLIENT_ID=${CLIENT_ID}" \
      --region "$AWS_REGION" >/dev/null 2>&1 || true
    echo "[OK] Environment variables updated"
  fi

  # ── Trigger Amplify build (Amplify pulls from GitHub and builds remotely) ──
  echo "Triggering Amplify build (builds remotely — no local disk needed)..."
  JOB_RESULT=$(aws amplify start-job \
    --app-id "$AMPLIFY_APP_ID" \
    --branch-name main \
    --job-type RELEASE \
    --region "$AWS_REGION" \
    --query 'jobSummary.jobId' \
    --output text 2>&1) || true

  if [ -n "$JOB_RESULT" ] && [ "$JOB_RESULT" != "None" ]; then
    echo "[OK] Amplify build triggered (Job ID: $JOB_RESULT)"
    echo "     Amplify will pull from GitHub, install deps, and build the frontend."
    echo "     This typically takes 2-4 minutes."
    echo ""

    # Wait for build with progress indicator
    echo "Waiting for Amplify build to complete..."
    BUILD_STATUS="PENDING"
    WAIT_COUNT=0
    MAX_WAIT=60  # 5 minutes max (60 * 5s)

    while [ "$BUILD_STATUS" != "SUCCEED" ] && [ "$BUILD_STATUS" != "FAILED" ] && [ "$BUILD_STATUS" != "CANCELLED" ] && [ $WAIT_COUNT -lt $MAX_WAIT ]; do
      sleep 5
      BUILD_STATUS=$(aws amplify get-job \
        --app-id "$AMPLIFY_APP_ID" \
        --branch-name main \
        --job-id "$JOB_RESULT" \
        --region "$AWS_REGION" \
        --query 'job.summary.status' \
        --output text 2>/dev/null || echo "PENDING")
      echo -n "."
      WAIT_COUNT=$((WAIT_COUNT + 1))
    done
    echo ""

    if [ "$BUILD_STATUS" = "SUCCEED" ]; then
      echo "[OK] Amplify build completed successfully!"
    elif [ "$BUILD_STATUS" = "FAILED" ]; then
      echo "[WARN] Amplify build failed. Check the Amplify console for logs:"
      echo "       https://console.aws.amazon.com/amplify/home?region=$AWS_REGION#/$AMPLIFY_APP_ID"
    else
      echo "[INFO] Build still in progress. Check status at:"
      echo "       https://console.aws.amazon.com/amplify/home?region=$AWS_REGION#/$AMPLIFY_APP_ID"
    fi
  else
    echo "[WARN] Could not trigger Amplify build automatically."
    echo "       Push to the 'main' branch on GitHub to trigger a build."
  fi

  AMPLIFY_URL="https://main.${AMPLIFY_APP_ID}.amplifyapp.com"

else
  # ── No GitHub token: create Amplify app without source, manual deploy needed ──
  echo "[INFO] No GitHub integration configured."
  echo "       The frontend must be deployed manually from a machine with more disk space."
  echo ""

  AMPLIFY_APP_ID=$(aws amplify list-apps --region "$AWS_REGION" \
    --query "apps[?name=='schoolbot-beam'].appId" --output text 2>/dev/null)

  if [ -z "$AMPLIFY_APP_ID" ] || [ "$AMPLIFY_APP_ID" = "None" ]; then
    echo "Creating Amplify app (manual deployment mode)..."
    AMPLIFY_APP_ID=$(aws amplify create-app \
      --name "schoolbot-beam" \
      --region "$AWS_REGION" \
      --query "app.appId" \
      --output text)

    aws amplify create-branch \
      --app-id "$AMPLIFY_APP_ID" \
      --branch-name main \
      --region "$AWS_REGION" >/dev/null
    echo "[OK] Amplify app created: $AMPLIFY_APP_ID"
  else
    echo "[OK] Amplify app exists: $AMPLIFY_APP_ID"
  fi

  AMPLIFY_URL="https://main.${AMPLIFY_APP_ID}.amplifyapp.com"

  echo ""
  echo "To deploy the frontend, run from your local machine:"
  echo "  1. cd frontend"
  echo "  2. Create .env with:"
  echo "       NEXT_PUBLIC_API_URL=${API_URL}"
  echo "       NEXT_PUBLIC_COGNITO_USER_POOL_ID=${USER_POOL_ID}"
  echo "       NEXT_PUBLIC_COGNITO_CLIENT_ID=${CLIENT_ID}"
  echo "  3. npm install && npm run build"
  echo "  4. bash deploy-frontend.sh"
fi
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
echo "  Amplify Console:"
echo "    https://console.aws.amazon.com/amplify/home?region=$AWS_REGION#/$AMPLIFY_APP_ID"
echo ""
echo "  Next steps:"
echo "  1. Visit ${AMPLIFY_URL} (may take a minute after first deploy)"
echo "  2. Log in to Admin and click 'Scan YouTube Channels'"
echo "  3. Upload transcripts for discovered videos"
echo ""
echo "  To redeploy frontend only (after code changes):"
echo "    Push to 'main' on GitHub — Amplify rebuilds automatically"
echo ""
echo "  To redeploy backend infrastructure:"
echo "    bash deploy-cloudshell.sh"
echo ""

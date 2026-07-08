# Signal-Zero GitHub Deployment Script (PowerShell)
# Automatically pushes to GitHub with authentication

Write-Host "🚀 Signal-Zero GitHub Deployment Script" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

# Check if GitHub CLI is installed
$ghPath = Get-Command gh -ErrorAction SilentlyContinue
if (-not $ghPath) {
    Write-Host "❌ GitHub CLI not found." -ForegroundColor Red
    Write-Host "Install from: https://cli.github.com" -ForegroundColor Yellow
    Write-Host "Or run: choco install gh" -ForegroundColor Yellow
    exit 1
}

# Authenticate with GitHub
Write-Host "🔐 Authenticating with GitHub..." -ForegroundColor Yellow
gh auth login

# Get current user
$GITHUB_USER = gh api user -q '.login'
Write-Host "✅ Authenticated as: $GITHUB_USER" -ForegroundColor Green
Write-Host ""

# Create/update repository
$REPO_NAME = "signal-zero-deployment"
Write-Host "📦 Processing GitHub repository..." -ForegroundColor Yellow

# Check if repo exists
try {
    $repoCheck = gh repo view "$GITHUB_USER/$REPO_NAME" 2>$null
    Write-Host "✅ Repository exists: $GITHUB_USER/$REPO_NAME" -ForegroundColor Green
} catch {
    Write-Host "Creating new repository..." -ForegroundColor Yellow
    gh repo create "$REPO_NAME" --public --source=. --remote=origin --push
    Write-Host "✅ Repository created and pushed!" -ForegroundColor Green
}

Write-Host ""
Write-Host "🌐 Repository URL: https://github.com/$GITHUB_USER/$REPO_NAME" -ForegroundColor Cyan
Write-Host "✨ Deployment complete!" -ForegroundColor Green

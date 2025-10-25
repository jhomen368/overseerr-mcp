# Contributing to Overseerr MCP Server

Thank you for your interest in contributing to Overseerr MCP Server! This document provides guidelines for contributing to the project.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for everyone.

## How to Contribute

### Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates. When you create a bug report, include as many details as possible:

- **Clear title and description**
- **Steps to reproduce** the issue
- **Expected behavior** vs actual behavior
- **Environment details** (OS, Node.js version, Docker version if applicable)
- **Error messages or logs** if available

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, include:

- **Clear title and description**
- **Use case** - why this enhancement would be useful
- **Possible implementation** if you have ideas

### Pull Requests

1. **Fork the repository** and create your branch from `main`
2. **Make your changes**:
   - Follow the existing code style
   - Add tests if applicable
   - Update documentation as needed
3. **Test your changes**:
   - Ensure the code builds: `npm run build`
   - Test with your Overseerr instance
4. **Commit your changes**:
   - Use clear, descriptive commit messages
   - Reference issue numbers if applicable
5. **Push to your fork** and submit a pull request

## Development Setup

### Prerequisites

- Node.js 18.0 or higher
- npm or yarn
- Access to an Overseerr instance for testing

### Local Development

1. Clone the repository:
   ```bash
   git clone https://github.com/jhomen368/overseerr-mcp-server.git
   cd overseerr-mcp-server
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file with your test credentials:
   ```env
   OVERSEERR_URL=https://your-test-overseerr.com
   OVERSEERR_API_KEY=your-api-key
   ```

4. Build the project:
   ```bash
   npm run build
   ```

5. Test locally:
   ```bash
   node build/index.js
   ```

### Development Workflow

- **Watch mode** for automatic rebuilds: `npm run watch`
- **Manual build**: `npm run build`

## Code Style

- Follow TypeScript best practices
- Use meaningful variable and function names
- Add comments for complex logic
- Keep functions focused and modular

## Testing

Before submitting a pull request:

1. Build the project successfully
2. Test with a real Overseerr instance
3. Verify all existing functionality still works
4. Test your new features/fixes

## Documentation

- Update README.md if you change functionality
- Add JSDoc comments for new functions/classes
- Include usage examples for new features

## Commit Message Guidelines

- Use the present tense ("Add feature" not "Added feature")
- Use the imperative mood ("Move cursor to..." not "Moves cursor to...")
- Limit the first line to 72 characters
- Reference issues and pull requests where appropriate

Example:
```
Add support for custom quality profiles

- Add profileId parameter to request_media tool
- Update documentation with examples
- Fixes #123
```

## Release Process

Maintainers handle releases:

1. Update version in `package.json`
2. Update CHANGELOG.md (if present)
3. Create git tag with version number
4. Push tag to trigger Docker build workflow

## Questions?

Feel free to open an issue for questions or clarifications about contributing.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

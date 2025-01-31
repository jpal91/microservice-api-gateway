# Microservice Ecommerce API Gateway
This repository is currently in development and contains an API Gateway microservice implementation. The gateway serves as a proxy between clients and backend services, providing a unified entry point for an ecommerce application's microservice architecture.

## Features
- Load balancing between service instances (Round Robin and Random strategies)
- Automatic service discovery via service registry
- Health checks and automatic re-registration
- Retry mechanisms with exponential backoff
- Request/Response header filtering
- Rate limiting
- CORS and security headers

## Current Status
This project is under active development. Core functionality is implemented but additional features, improvements, and documentation are planned.

## Related Services
- [Service Registry](https://github.com/jpal91/microservice-service-registry)
- Product Service
- Order Service
- Cart Service
- User Service

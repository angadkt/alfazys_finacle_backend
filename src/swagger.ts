import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Alfazys Finacle API',
      version: '1.0.0',
      description: 'API documentation for the Alfazys Finacle Backend',
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Development Server',
      },
    ],
  },
  apis: ['./src/routes/*.ts'], // Scan these files for swagger annotations
};

export const swaggerSpec = swaggerJsdoc(options);

#!/usr/bin/env node

/**
 * Jira MCP Server
 * Provides MCP tools for Jira integration
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import dotenv from 'dotenv';

dotenv.config();

// Jira Client
class JiraClient {
  private client: AxiosInstance;
  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.JIRA_URL!;
    const auth = Buffer.from(
      `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
    ).toString('base64');

    this.client = axios.create({
      baseURL: `${this.baseUrl}/rest/api/3`,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
  }

  async getIssue(issueKey: string) {
    const response = await this.client.get(`/issue/${issueKey}`);
    return response.data;
  }

  async searchIssues(jql: string, maxResults: number = 50) {
    // Old GET /search returns 410 on Jira Cloud; use enhanced search/jql
    const response = await this.client.post('/search/jql', {
      jql,
      maxResults,
      fields: ['summary', 'status', 'issuetype', 'priority', 'updated'],
    });
    return response.data;
  }

  async addComment(issueKey: string, comment: any) {
    const response = await this.client.post(
      `/issue/${issueKey}/comment`,
      { body: comment }
    );
    return response.data;
  }

  async uploadAttachment(issueKey: string, filename: string, content: Buffer) {
    const form = new FormData();
    form.append('file', content, {
      filename,
      contentType: 'image/png'
    });

    const response = await axios.post(
      `${this.baseUrl}/rest/api/3/issue/${issueKey}/attachments`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          'Authorization': `Basic ${Buffer.from(
            `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
          ).toString('base64')}`,
          'X-Atlassian-Token': 'no-check'
        }
      }
    );
    return response.data;
  }

  async transitionIssue(issueKey: string, transitionId: string) {
    const response = await this.client.post(
      `/issue/${issueKey}/transitions`,
      { transition: { id: transitionId } }
    );
    return response.data;
  }

  async getTransitions(issueKey: string) {
    const response = await this.client.get(`/issue/${issueKey}/transitions`);
    return response.data;
  }

  async updateIssue(issueKey: string, fields: any) {
    const response = await this.client.put(`/issue/${issueKey}`, { fields });
    return response.data;
  }

  async addLabel(issueKey: string, label: string) {
    const response = await this.client.put(`/issue/${issueKey}`, {
      update: {
        labels: [{ add: label }]
      }
    });
    return response.data;
  }
}

// MCP Server
const server = new Server(
  {
    name: 'jira-qa-server',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

const jiraClient = new JiraClient();

// Define tools
const tools: Tool[] = [
  {
    name: 'jira_get_issue',
    description: 'Get details of a Jira issue by key (e.g., PROJ-123)',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'The Jira issue key (e.g., PROJ-123)'
        }
      },
      required: ['issueKey']
    }
  },
  {
    name: 'jira_search_issues',
    description: 'Search Jira issues using JQL (Jira Query Language)',
    inputSchema: {
      type: 'object',
      properties: {
        jql: {
          type: 'string',
          description: 'JQL query string (e.g., "status = \\"Ready for QA\\"")'
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results (default: 50)',
          default: 50
        }
      },
      required: ['jql']
    }
  },
  {
    name: 'jira_add_comment',
    description: 'Add a comment to a Jira issue',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'The Jira issue key'
        },
        comment: {
          type: 'object',
          description: 'Comment in Atlassian Document Format (ADF)'
        }
      },
      required: ['issueKey', 'comment']
    }
  },
  {
    name: 'jira_upload_attachment',
    description: 'Upload an attachment (screenshot) to a Jira issue',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'The Jira issue key'
        },
        filename: {
          type: 'string',
          description: 'Filename for the attachment'
        },
        content: {
          type: 'string',
          description: 'Base64 encoded file content'
        }
      },
      required: ['issueKey', 'filename', 'content']
    }
  },
  {
    name: 'jira_add_label',
    description: 'Add a label to a Jira issue',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'The Jira issue key'
        },
        label: {
          type: 'string',
          description: 'Label to add (e.g., "qa-passed")'
        }
      },
      required: ['issueKey', 'label']
    }
  },
  {
    name: 'jira_transition_issue',
    description: 'Transition a Jira issue to a new status',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'The Jira issue key'
        },
        transitionName: {
          type: 'string',
          description: 'Name of the transition (e.g., "QA Approved")'
        }
      },
      required: ['issueKey', 'transitionName']
    }
  },
  {
    name: 'jira_get_transitions',
    description: 'Get available transitions for a Jira issue',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'The Jira issue key'
        }
      },
      required: ['issueKey']
    }
  }
];

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'jira_get_issue': {
        const { issueKey } = args as { issueKey: string };
        const issue = await jiraClient.getIssue(issueKey);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(issue, null, 2)
            }
          ]
        };
      }

      case 'jira_search_issues': {
        const { jql, maxResults } = args as { jql: string; maxResults?: number };
        const results = await jiraClient.searchIssues(jql, maxResults);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2)
            }
          ]
        };
      }

      case 'jira_add_comment': {
        const { issueKey, comment } = args as { issueKey: string; comment: any };
        const result = await jiraClient.addComment(issueKey, comment);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      case 'jira_upload_attachment': {
        const { issueKey, filename, content } = args as {
          issueKey: string;
          filename: string;
          content: string;
        };
        const buffer = Buffer.from(content, 'base64');
        const result = await jiraClient.uploadAttachment(issueKey, filename, buffer);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      case 'jira_add_label': {
        const { issueKey, label } = args as { issueKey: string; label: string };
        await jiraClient.addLabel(issueKey, label);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, label })
            }
          ]
        };
      }

      case 'jira_transition_issue': {
        const { issueKey, transitionName } = args as {
          issueKey: string;
          transitionName: string;
        };
        
        // Get available transitions
        const transitions = await jiraClient.getTransitions(issueKey);
        const transition = transitions.transitions.find(
          (t: any) => t.name === transitionName
        );

        if (!transition) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Transition "${transitionName}" not found`,
                  availableTransitions: transitions.transitions.map((t: any) => t.name)
                })
              }
            ],
            isError: true
          };
        }

        await jiraClient.transitionIssue(issueKey, transition.id);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, transitionName })
            }
          ]
        };
      }

      case 'jira_get_transitions': {
        const { issueKey } = args as { issueKey: string };
        const transitions = await jiraClient.getTransitions(issueKey);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(transitions, null, 2)
            }
          ]
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: error.message,
            stack: error.stack
          })
        }
      ],
      isError: true
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Jira MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

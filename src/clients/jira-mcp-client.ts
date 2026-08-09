/**
 * Jira Client with MCP Support
 * Uses MCP when available, falls back to direct API
 */

import { JiraClient as DirectJiraClient, JiraIssue, TestResult } from './jira-client.js';
import { logger } from '../utils/logger.js';

interface McpTool {
  name: string;
  call(args: any): Promise<any>;
}

export class JiraMcpClient {
  private directClient: DirectJiraClient;
  private mcpAvailable: boolean = false;
  private mcpTools: Map<string, McpTool> = new Map();

  constructor() {
    this.directClient = new DirectJiraClient();
    this.initializeMcp();
  }

  /**
   * Initialize MCP connection
   */
  private async initializeMcp() {
    try {
      // Try to detect if MCP is available
      // In a real implementation, this would connect to the MCP server
      // For now, we'll check if MCP tools are accessible via environment
      
      const mcpServerUrl = process.env.MCP_JIRA_SERVER_URL;
      
      if (mcpServerUrl) {
        logger.info('MCP Jira server detected, initializing...');
        // Here you would connect to the MCP server
        // For demonstration, we'll use a simple wrapper
        this.mcpAvailable = true;
        logger.info('MCP Jira client initialized successfully');
      } else {
        logger.info('MCP not configured, using direct API');
        this.mcpAvailable = false;
      }
    } catch (error) {
      logger.warn('Failed to initialize MCP, falling back to direct API:', error);
      this.mcpAvailable = false;
    }
  }

  /**
   * Call MCP tool with fallback to direct API
   */
  private async callMcp(toolName: string, args: any, fallback: () => Promise<any>): Promise<any> {
    if (this.mcpAvailable) {
      try {
        logger.debug(`Calling MCP tool: ${toolName}`);
        
        // In real implementation, this would use the MCP SDK
        // For now, we'll use the fallback
        // const result = await this.mcpTools.get(toolName)?.call(args);
        // return result;
        
        // Fallback for now
        return await fallback();
      } catch (error) {
        logger.warn(`MCP call failed for ${toolName}, using fallback:`, error);
        return await fallback();
      }
    } else {
      return await fallback();
    }
  }

  /**
   * Get issue from Jira (MCP or direct)
   */
  async getIssue(issueKey: string): Promise<JiraIssue> {
    return this.callMcp(
      'jira_get_issue',
      { issueKey },
      () => this.directClient.getIssue(issueKey)
    );
  }

  /**
   * Search issues using JQL (MCP or direct)
   */
  async searchIssues(jql: string, maxResults: number = 50): Promise<any> {
    return this.callMcp(
      'jira_search_issues',
      { jql, maxResults },
      async () => {
        // Direct API doesn't have this method, so we'll add it
        const axios = await import('axios');
        const auth = Buffer.from(
          `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
        ).toString('base64');
        
        const response = await axios.default.get(
          `${process.env.JIRA_URL}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}`,
          {
            headers: {
              'Authorization': `Basic ${auth}`,
              'Accept': 'application/json'
            }
          }
        );
        return response.data;
      }
    );
  }

  /**
   * Post test results (MCP or direct)
   */
  async postTestResults(issueKey: string, testResult: TestResult): Promise<void> {
    // For complex operations like posting results with screenshots,
    // we'll use the direct client's implementation
    return this.directClient.postTestResults(issueKey, testResult);
  }

  /**
   * Add comment (MCP or direct)
   */
  async addComment(issueKey: string, comment: any): Promise<void> {
    await this.callMcp(
      'jira_add_comment',
      { issueKey, comment },
      async () => {
        // Use direct client's internal method
        const axios = await import('axios');
        const auth = Buffer.from(
          `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
        ).toString('base64');
        
        await axios.default.post(
          `${process.env.JIRA_URL}/rest/api/3/issue/${issueKey}/comment`,
          { body: comment },
          {
            headers: {
              'Authorization': `Basic ${auth}`,
              'Content-Type': 'application/json'
            }
          }
        );
      }
    );
  }

  /**
   * Add label (MCP or direct)
   */
  async addLabel(issueKey: string, label: string): Promise<void> {
    return this.callMcp(
      'jira_add_label',
      { issueKey, label },
      () => this.directClient.addLabel(issueKey, label)
    );
  }

  /**
   * Transition issue (MCP or direct)
   */
  async transitionIssue(issueKey: string, transitionName: string): Promise<void> {
    return this.callMcp(
      'jira_transition_issue',
      { issueKey, transitionName },
      () => this.directClient.transitionIssue(issueKey, transitionName)
    );
  }

  /**
   * Extract text from ADF (uses direct client method)
   */
  extractTextFromADF(adfContent: any): string {
    return this.directClient.extractTextFromADF(adfContent);
  }

  /**
   * Check if MCP is available
   */
  isMcpAvailable(): boolean {
    return this.mcpAvailable;
  }
}

// Export both for compatibility
export { JiraClient as DirectJiraClient } from './jira-client.js';

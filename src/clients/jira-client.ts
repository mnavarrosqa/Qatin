import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import { logger } from '../utils/logger';
import {
  assertJiraCredentials,
  getJiraCredentials,
  jiraAuthHeader,
} from '../jira/credentials';

export interface JiraComment {
  id?: string;
  author?: { displayName?: string; emailAddress?: string };
  body?: unknown;
  created?: string;
  updated?: string;
}

export interface JiraCommentField {
  comments: JiraComment[];
  total?: number;
  maxResults?: number;
  startAt?: number;
}

export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description?: any;
    issuetype: { name: string };
    priority?: { name: string };
    status: { name: string };
    project: { key: string; name: string };
    assignee?: { displayName: string; emailAddress: string };
    labels?: string[];
    /** Present when getIssue enriches with /comment (devs often leave how-to-test notes). */
    comment?: JiraCommentField;
    [key: string]: any;
  };
}

/** Plain-text dump of issue comments for analyzers / chat understanding. */
export function formatJiraCommentsText(commentField: unknown): string {
  const comments = (commentField as JiraCommentField | undefined)?.comments;
  if (!Array.isArray(comments) || comments.length === 0) return '';

  const extract = (content: unknown): string => {
    if (!content) return '';
    if (typeof content === 'string') return content;
    let text = '';
    const traverse = (node: any) => {
      if (node?.type === 'text') text += `${node.text} `;
      if (Array.isArray(node?.content)) node.content.forEach(traverse);
    };
    traverse(content);
    return text.trim();
  };

  return comments
    .map((c, i) => {
      const author =
        c.author?.displayName || c.author?.emailAddress || 'Desconocido';
      const created = c.created ? String(c.created).slice(0, 10) : '';
      const body = extract(c.body);
      if (!body) return null;
      return `[${i + 1}] ${author}${created ? ` (${created})` : ''}:\n${body}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

export interface TestResult {
  passed: boolean;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  screenshots: Array<{
    name: string;
    path: string;
    buffer: Buffer;
  }>;
  details: string;
  executionTime: number;
}

export class JiraClient {
  private client: AxiosInstance;
  private baseUrl: string;
  private auth: string;

  constructor() {
    const creds = getJiraCredentials();
    assertJiraCredentials(creds);
    this.baseUrl = creds.url;
    this.auth = jiraAuthHeader(creds);

    this.client = axios.create({
      baseURL: `${this.baseUrl}/rest/api/3`,
      headers: {
        Authorization: this.auth,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });

    logger.info('Jira client initialized');
  }

  /**
   * Get issue comments (devs often leave how-to-test / contract notes here).
   */
  async getIssueComments(issueKey: string): Promise<JiraCommentField> {
    try {
      const response = await this.client.get(`/issue/${issueKey}/comment`, {
        params: { maxResults: 100, orderBy: 'created' },
      });
      const data = response.data || {};
      return {
        comments: Array.isArray(data.comments) ? data.comments : [],
        total: typeof data.total === 'number' ? data.total : undefined,
        maxResults:
          typeof data.maxResults === 'number' ? data.maxResults : undefined,
        startAt: typeof data.startAt === 'number' ? data.startAt : undefined,
      };
    } catch (error: any) {
      logger.warn(
        `Could not fetch comments for ${issueKey}:`,
        error.message
      );
      return { comments: [], total: 0 };
    }
  }

  /**
   * Get issue details from Jira (includes comments — used for QA guidance).
   */
  async getIssue(issueKey: string): Promise<JiraIssue> {
    try {
      logger.info(`Fetching Jira issue: ${issueKey}`);
      const [issueResponse, commentField] = await Promise.all([
        this.client.get(`/issue/${issueKey}`),
        this.getIssueComments(issueKey),
      ]);
      const issue = issueResponse.data as JiraIssue;
      issue.fields = issue.fields || ({} as JiraIssue['fields']);
      issue.fields.comment = commentField;
      return issue;
    } catch (error: any) {
      logger.error(`Error fetching Jira issue ${issueKey}:`, error.message);
      throw new Error(`No se pudo traer el issue de Jira: ${error.message}`);
    }
  }

  /**
   * Extract plain text from Jira's ADF (Atlassian Document Format)
   */
  extractTextFromADF(adfContent: any): string {
    if (!adfContent) return '';
    
    if (typeof adfContent === 'string') return adfContent;

    let text = '';

    const traverse = (node: any) => {
      if (node.type === 'text') {
        text += node.text + ' ';
      }
      
      if (node.content && Array.isArray(node.content)) {
        node.content.forEach(traverse);
      }
    };

    traverse(adfContent);
    return text.trim();
  }

  /**
   * Post a comment on a Jira issue with test results and screenshots
   */
  async postTestResults(
    issueKey: string,
    testResult: TestResult
  ): Promise<void> {
    try {
      logger.info(`Posting test results to ${issueKey}`);

      // Create comment body with ADF format
      const status = testResult.passed ? '✅ PASSED' : '❌ FAILED';
      const emoji = testResult.passed ? '✅' : '❌';
      
      const commentBody: any = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'panel',
            attrs: {
              panelType: testResult.passed ? 'success' : 'error'
            },
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: `${emoji} Automated QA Test Results`,
                    marks: [{ type: 'strong' }]
                  }
                ]
              }
            ]
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Status: ', marks: [{ type: 'strong' }] },
              { type: 'text', text: status }
            ]
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Test Summary: ', marks: [{ type: 'strong' }] },
              {
                type: 'text',
                text: `${testResult.passedTests}/${testResult.totalTests} tests passed`
              }
            ]
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Execution Time: ', marks: [{ type: 'strong' }] },
              {
                type: 'text',
                text: `${(testResult.executionTime / 1000).toFixed(2)}s`
              }
            ]
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Timestamp: ', marks: [{ type: 'strong' }] },
              { type: 'text', text: new Date().toISOString() }
            ]
          }
        ]
      };

      // Add details section
      if (testResult.details) {
        commentBody.content.push(
          {
            type: 'heading',
            attrs: { level: 3 },
            content: [{ type: 'text', text: 'Test Details' }]
          },
          {
            type: 'codeBlock',
            attrs: { language: 'text' },
            content: [{ type: 'text', text: testResult.details }]
          }
        );
      }

      // Post the main comment
      const commentResponse = await this.client.post(
        `/issue/${issueKey}/comment`,
        { body: commentBody }
      );

      const commentId = commentResponse.data.id;
      logger.info(`Comment posted with ID: ${commentId}`);

      // Upload screenshots as attachments
      if (testResult.screenshots.length > 0) {
        logger.info(`Uploading ${testResult.screenshots.length} screenshots...`);
        
        for (const screenshot of testResult.screenshots) {
          await this.uploadAttachment(issueKey, screenshot.name, screenshot.buffer);
        }

        // Add a follow-up comment referencing screenshots
        const screenshotComment = {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: '📸 Test Evidence - Screenshots:',
                  marks: [{ type: 'strong' }]
                }
              ]
            },
            {
              type: 'bulletList',
              content: testResult.screenshots.map(s => ({
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'text', text: s.name, marks: [{ type: 'code' }] }
                    ]
                  }
                ]
              }))
            },
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: '💡 Check attachments above for detailed screenshots',
                  marks: [{ type: 'em' }]
                }
              ]
            }
          ]
        };

        await this.client.post(`/issue/${issueKey}/comment`, {
          body: screenshotComment
        });
      }

      logger.info(`Successfully posted results to ${issueKey}`);

    } catch (error: any) {
      logger.error(`Error posting results to Jira:`, error.response?.data || error.message);
      throw new Error(`No se pudieron publicar los resultados del test: ${error.message}`);
    }
  }

  /**
   * Create a new Jira issue (typically a Bug).
   */
  async createIssue(opts: {
    projectKey: string;
    summary: string;
    description: string;
    issueType?: string;
    labels?: string[];
    attachments?: Array<{ name: string; buffer: Buffer }>;
  }): Promise<{ key: string; id: string; self: string }> {
    const issueType = opts.issueType || 'Bug';
    const paragraphs = opts.description
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: line }],
      }));

    const body = {
      fields: {
        project: { key: opts.projectKey },
        summary: opts.summary.slice(0, 255),
        issuetype: { name: issueType },
        description: {
          type: 'doc',
          version: 1,
          content: paragraphs.length
            ? paragraphs
            : [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: opts.description || '(sin detalle)' }],
                },
              ],
        },
        ...(opts.labels?.length ? { labels: opts.labels } : {}),
      },
    };

    try {
      logger.info(`Creating Jira ${issueType} in ${opts.projectKey}: ${opts.summary}`);
      const response = await this.client.post('/issue', body);
      const created = response.data as { key: string; id: string; self: string };

      if (opts.attachments?.length) {
        for (const file of opts.attachments) {
          try {
            await this.uploadAttachment(created.key, file.name, file.buffer);
          } catch (attachErr: any) {
            logger.warn(
              `Attachment failed for ${created.key}/${file.name}:`,
              attachErr?.message || attachErr
            );
          }
        }
      }

      logger.info(`Created Jira issue ${created.key}`);
      return created;
    } catch (error: any) {
      logger.error(
        'Error creating Jira issue:',
        error.response?.data || error.message
      );
      throw new Error(
        `No se pudo crear el issue en Jira: ${
          error.response?.data?.errorMessages?.join?.(', ') ||
          error.message
        }`
      );
    }
  }

  /**
   * Upload an attachment to a Jira issue
   */
  private async uploadAttachment(
    issueKey: string,
    filename: string,
    buffer: Buffer
  ): Promise<void> {
    try {
      const form = new FormData();
      form.append('file', buffer, {
        filename,
        contentType: 'image/png'
      });

      await axios.post(
        `${this.baseUrl}/rest/api/3/issue/${issueKey}/attachments`,
        form,
        {
          headers: {
            ...form.getHeaders(),
            Authorization: this.auth,
            'X-Atlassian-Token': 'no-check',
          },
        }
      );

      logger.info(`Uploaded attachment: ${filename}`);
    } catch (error: any) {
      logger.error(`Error uploading attachment:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Transition issue to a specific status
   */
  async transitionIssue(issueKey: string, transitionName: string): Promise<void> {
    try {
      // Get available transitions
      const transitionsResponse = await this.client.get(
        `/issue/${issueKey}/transitions`
      );

      const transition = transitionsResponse.data.transitions.find(
        (t: any) => t.name === transitionName
      );

      if (!transition) {
        logger.warn(
          `Transition "${transitionName}" not found for ${issueKey}`
        );
        return;
      }

      await this.client.post(`/issue/${issueKey}/transitions`, {
        transition: { id: transition.id }
      });

      logger.info(`Transitioned ${issueKey} to ${transitionName}`);
    } catch (error: any) {
      logger.error(`Error transitioning issue:`, error.message);
    }
  }

  /**
   * Add a label to an issue
   */
  async addLabel(issueKey: string, label: string): Promise<void> {
    try {
      await this.client.put(`/issue/${issueKey}`, {
        update: {
          labels: [{ add: label }]
        }
      });

      logger.info(`Added label "${label}" to ${issueKey}`);
    } catch (error: any) {
      logger.error(`Error adding label:`, error.message);
    }
  }
}

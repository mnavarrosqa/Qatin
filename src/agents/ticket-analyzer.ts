import OpenAI from 'openai';
import { logger } from '../utils/logger';
import { JiraIssue, JiraClient } from '../clients/jira-client';

export interface TestStrategy {
  testType: 'ui' | 'api' | 'manual' | 'mixed';
  scenarios: TestScenario[];
  summary: string;
  estimatedDuration: number;
  priority: 'high' | 'medium' | 'low';
}

export interface TestScenario {
  id: string;
  description: string;
  steps: string[];
  expectedResults: string[];
  urls?: string[];
  selectors?: string[];
  apiEndpoints?: string[];
}

export class TicketAnalyzer {
  private openai: OpenAI;
  private jiraClient: JiraClient;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    this.jiraClient = new JiraClient();
    logger.info('TicketAnalyzer initialized with OpenAI');
  }

  /**
   * Analyze a Jira ticket and generate test strategy
   */
  async analyzeTicket(ticket: JiraIssue): Promise<TestStrategy> {
    try {
      logger.info(`Analyzing ticket: ${ticket.key}`);

      // Extract ticket information
      const description = this.jiraClient.extractTextFromADF(
        ticket.fields.description
      );

      const acceptanceCriteria = this.extractAcceptanceCriteria(description);

      // Build prompt for LLM
      const prompt = this.buildAnalysisPrompt(ticket, description, acceptanceCriteria);

      // Call OpenAI
      const response = await this.openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4-turbo-preview',
        messages: [
          {
            role: 'system',
            content: `You are an expert QA engineer who creates comprehensive test strategies. 
You analyze Jira tickets and generate detailed, actionable test scenarios for Playwright automation.
Focus on UI testing, user flows, edge cases, and visual validation.
Always provide specific CSS selectors, URLs, and step-by-step instructions.`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3
      });

      const content = response.choices[0].message.content;
      if (!content) {
        throw new Error('Empty response from OpenAI');
      }

      const strategy = JSON.parse(content) as TestStrategy;

      // Enrich strategy with ticket context
      strategy.priority = this.determinePriority(ticket);

      logger.info(`Generated ${strategy.scenarios.length} test scenarios for ${ticket.key}`);

      return strategy;

    } catch (error: any) {
      logger.error('Error analyzing ticket:', error);
      throw new Error(`Failed to analyze ticket: ${error.message}`);
    }
  }

  /**
   * Build analysis prompt for OpenAI
   */
  private buildAnalysisPrompt(
    ticket: JiraIssue,
    description: string,
    acceptanceCriteria: string[]
  ): string {
    return `
Analyze this Jira ticket and generate a comprehensive test strategy:

**Ticket Information:**
- Key: ${ticket.key}
- Type: ${ticket.fields.issuetype.name}
- Summary: ${ticket.fields.summary}
- Priority: ${ticket.fields.priority?.name || 'Medium'}
- Status: ${ticket.fields.status.name}

**Description:**
${description || 'No description provided'}

**Acceptance Criteria:**
${acceptanceCriteria.length > 0 ? acceptanceCriteria.join('\n') : 'Not specified'}

**Labels:** ${ticket.fields.labels?.join(', ') || 'None'}

**Instructions:**
Generate a test strategy with multiple test scenarios. For each scenario:
1. Provide clear, actionable steps
2. Include specific URLs to test (use placeholders like {{BASE_URL}})
3. Include CSS selectors for elements to interact with (e.g., button[data-testid="submit"])
4. Describe expected results after each step
5. Cover happy paths, edge cases, and error scenarios

Focus on UI testing scenarios that can be automated with Playwright.

**Response Format (JSON):**
{
  "testType": "ui" | "api" | "mixed",
  "summary": "Brief summary of test strategy",
  "estimatedDuration": 30,
  "scenarios": [
    {
      "id": "scenario-1",
      "description": "Test user login flow",
      "steps": [
        "Navigate to {{BASE_URL}}/login",
        "Fill email field with test@example.com",
        "Fill password field",
        "Click submit button"
      ],
      "expectedResults": [
        "Login page loads successfully",
        "Form validation shows no errors",
        "User is redirected to dashboard",
        "Welcome message is displayed"
      ],
      "urls": ["{{BASE_URL}}/login", "{{BASE_URL}}/dashboard"],
      "selectors": [
        "input[name='email']",
        "input[type='password']",
        "button[type='submit']",
        ".welcome-message"
      ]
    }
  ]
}
`;
  }

  /**
   * Extract acceptance criteria from description
   */
  private extractAcceptanceCriteria(description: string): string[] {
    const criteria: string[] = [];

    // Common markers for acceptance criteria
    const markers = [
      /acceptance criteria[:\s]*/i,
      /AC[:\s]*/i,
      /given.*when.*then/gi,
      /requirements[:\s]*/i
    ];

    let extracted = false;
    for (const marker of markers) {
      const match = description.match(marker);
      if (match) {
        const startIndex = match.index! + match[0].length;
        const remainingText = description.substring(startIndex);
        
        // Extract bullet points or numbered lists
        const lines = remainingText.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (
            trimmed.match(/^[-*•]\s/) ||
            trimmed.match(/^\d+\.\s/) ||
            trimmed.match(/^given|when|then/i)
          ) {
            criteria.push(trimmed.replace(/^[-*•\d.]\s*/, ''));
          } else if (criteria.length > 0 && trimmed === '') {
            break; // End of criteria section
          }
        }
        
        if (criteria.length > 0) {
          extracted = true;
          break;
        }
      }
    }

    return criteria;
  }

  /**
   * Determine test priority based on ticket
   */
  private determinePriority(ticket: JiraIssue): 'high' | 'medium' | 'low' {
    const priorityName = ticket.fields.priority?.name.toLowerCase() || 'medium';
    
    if (priorityName.includes('highest') || priorityName.includes('critical')) {
      return 'high';
    } else if (priorityName.includes('high')) {
      return 'high';
    } else if (priorityName.includes('low') || priorityName.includes('lowest')) {
      return 'low';
    }
    
    return 'medium';
  }

  /**
   * Generate test scenarios for common issue types
   */
  async generateFallbackStrategy(ticket: JiraIssue): Promise<TestStrategy> {
    logger.info('Generating fallback test strategy');
    
    // Basic strategy when AI analysis fails
    return {
      testType: 'ui',
      summary: `Basic test strategy for ${ticket.fields.issuetype.name}`,
      estimatedDuration: 60,
      priority: this.determinePriority(ticket),
      scenarios: [
        {
          id: 'scenario-1',
          description: 'Verify basic functionality',
          steps: [
            'Navigate to application',
            'Verify page loads correctly',
            'Check for console errors',
            'Take screenshots'
          ],
          expectedResults: [
            'Page loads without errors',
            'No console errors',
            'UI elements are visible'
          ],
          urls: [`{{BASE_URL}}`],
          selectors: ['body', 'main', 'header']
        }
      ]
    };
  }
}

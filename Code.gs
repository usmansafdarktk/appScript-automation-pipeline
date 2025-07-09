// ========== Code.gs ==========
// This script handles Google Form submissions, direct API calls for budgets <= $20,
// and manager approval for budgets > $20, integrating with an AWS API Gateway.
// Requires: ApprovalEmail.html for email template

// --- SCRIPT PROPERTIES ---
// Set in Project Settings > Script Properties:
// 1. SCRIPT_URL: The URL of this script when deployed as a web app.
// 2. API_GATEWAY_URL: The API Gateway URL.

const BUDGET_LIMIT = 20; // Budget threshold for direct API call vs. approval.
const API_GATEWAY_URL = PropertiesService.getScriptProperties().getProperty('API_GATEWAY_URL');

/**
 * Triggered on form submission.
 * Fetches the latest form response, processes the budget, and either calls the API directly or sends an approval email.
 */
function onFormSubmit(e) {
  try {
    Logger.log('Function triggered. Fetching latest form submission.');

    // --- Fetch Latest Form Response ---
    const form = FormApp.getActiveForm();
    const allResponses = form.getResponses();
    const latestResponse = allResponses[allResponses.length - 1];

    if (!latestResponse) {
      Logger.log('ERROR: No form responses found.');
      return;
    }

    const itemResponses = latestResponse.getItemResponses();
    const namedValues = {};
    itemResponses.forEach(itemResponse => {
      const question = itemResponse.getItem().getTitle();
      const answer = itemResponse.getResponse();
      namedValues[question] = [answer];
    });

    const submitterEmail = latestResponse.getRespondentEmail();
    if (!submitterEmail) {
      Logger.log('ERROR: Respondent email not found. Ensure "Collect email addresses" is enabled.');
      return;
    }

    Logger.log(`Manually fetched data: ${JSON.stringify(namedValues, null, 2)}`);
    Logger.log(`Submitter Email: ${submitterEmail}`);

    // --- Extract Form Data ---
    const formResponse = namedValues;
    const email = submitterEmail;
    const budget = formResponse['Requested Budget'] ? parseFloat(formResponse['Requested Budget'][0]) : 0;
    const module = formResponse['Module'] ? formResponse['Module'][0] : 'No Module Provided';
    const managerEmail = formResponse["Manager's Email"] ? formResponse["Manager's Email"][0] : null;

    if (!managerEmail) {
      Logger.log("ERROR: 'Manager's Email' field missing. Cannot proceed.");
      MailApp.sendEmail('usmansafderktk@gmail.com', 'CRITICAL Error', "Manager's Email not provided in form response.");
      return;
    }

    Logger.log(`Submission - Email: ${email}, Budget: ${budget}, Module: ${module}, Manager: ${managerEmail}`);

    // --- Business Logic ---
    if (budget <= BUDGET_LIMIT) {
      Logger.log(`Budget of ${budget} is <= ${BUDGET_LIMIT}. Calling API Gateway directly.`);

      // Prepare API payload
      const payload = {
        email: email,
        budget: budget.toString(),
        module: module
      };

      Logger.log(`API Payload: ${JSON.stringify(payload)}`);

      const options = {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      };

      try {
        const response = UrlFetchApp.fetch(API_GATEWAY_URL, options);
        Logger.log(`API Response Code: ${response.getResponseCode()}`);
        Logger.log(`API Response Body: ${response.getContentText()}`);

        // Notify submitter of automatic approval
        MailApp.sendEmail(
          email,
          'Budget Request Auto-Approved',
          `Hello,\n\nYour budget request of $${budget} for module ${module} has been auto-approved as it is within the $${BUDGET_LIMIT} limit.`
        );
      } catch (apiError) {
        Logger.log(`Error calling API: ${apiError}`);
        MailApp.sendEmail(
          'usmansafderktk@gmail.com',
          'API Trigger Failed',
          `Failed to trigger API for ${email}'s request.\n\nError: ${apiError}`
        );
      }
    } else {
      Logger.log(`Budget of ${budget} exceeds ${BUDGET_LIMIT}. Sending approval email to ${managerEmail}.`);
      sendApprovalEmail(managerEmail, email, budget, module);
    }
  } catch (error) {
    Logger.log(`FATAL Error in onFormSubmit: ${error}\nStack: ${error.stack}`);
    MailApp.sendEmail(
      'usmansafderktk@gmail.com',
      'CRITICAL Error in Budget Approval Script',
      `An error occurred: ${error}\n\nStack: ${error.stack}`
    );
  }
}

/**
 * Sends an approval email to the manager with links to approve or deny the request.
 */
function sendApprovalEmail(managerEmail, submitterEmail, budget, module) {
  const scriptUrl = PropertiesService.getScriptProperties().getProperty('SCRIPT_URL');
  if (!scriptUrl) {
    Logger.log('FATAL ERROR: SCRIPT_URL not set in Script Properties.');
    MailApp.sendEmail(
      'usmansafderktk@gmail.com',
      'CRITICAL SCRIPT ERROR',
      'SCRIPT_URL property not set. Approval workflow broken.'
    );
    return;
  }

  // Create unique tokens for approval/denial
  const approvalToken = `approve-${Utilities.getUuid()}`;
  const denialToken = `deny-${Utilities.getUuid()}`;

  // Store request data in cache
  const cache = CacheService.getScriptCache();
  DO NOT SHARE SENSITIVE INFORMATION IN PUBLIC CHATS, PLEASE REDACT AND RESEND IF NECESSARY const requestData = JSON.stringify({ submitterEmail, budget, module });
  cache.put(approvalToken, requestData, 21600); // Store for 6 hours
  cache.put(denialToken, requestData, 21600);   // Store for 6 hours

  // Prepare data for HTML template
  const templateData = {
    submitter: submitterEmail,
    budget: budget.toFixed(2),
    module: module,
    approvalUrl: `${scriptUrl}?token=${approvalToken}`,
    denialUrl: `${scriptUrl}?token=${denialToken}`
  };

  const htmlTemplate = HtmlService.createTemplateFromFile('ApprovalEmail');
  htmlTemplate.data = templateData;
  const htmlBody = htmlTemplate.evaluate().getContent();

  const subject = `Budget Request Approval Needed for ${submitterEmail}`;

  GmailApp.sendEmail(managerEmail, subject, '', {
    htmlBody: htmlBody,
    name: 'Automated Budget Approval System'
  });

  Logger.log(`Approval email sent to ${managerEmail}.`);
}

/**
 * Handles web app requests when the manager clicks approval/denial links.
 */
function doGet(e) {
  const token = e.parameter.token;
  const cache = CacheService.getScriptCache();
  const requestDataJSON = cache.get(token);

  if (!requestDataJSON) {
    return HtmlService.createHtmlOutput('<h1>Link Expired</h1><p>This link has expired or has already been used.</p>');
  }

  cache.remove(token); // Prevent reuse
  const requestData = JSON.parse(requestDataJSON);
  const { submitterEmail, budget, module } = requestData;

  if (token.startsWith('approve')) {
    Logger.log(`Request APPROVED by manager. Submitter: ${submitterEmail}, Budget: ${budget}, Module: ${module}`);

    // Trigger API Gateway
    const payload = {
      email: submitterEmail,
      budget: budget.toString(),
      module: module
    };

    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    try {
      const response = UrlFetchApp.fetch(API_GATEWAY_URL, options);
      Logger.log(`API Response Code: ${response.getResponseCode()}`);
      Logger.log(`API Response Body: ${response.getContentText()}`);

      // Notify submitter
      MailApp.sendEmail(
        submitterEmail,
        'Your Budget Request Was Approved',
        `Hello,\n\nYour budget request for $${budget} for module ${module} has been approved by your manager.`
      );
    } catch (apiError) {
      Logger.log(`Error calling API: ${apiError}`);
      MailApp.sendEmail(
        'usmansafderktk@gmail.com',
        'API Trigger Failed',
        `Failed to trigger API for ${submitterEmail}'s request.\n\nError: ${apiError}`
      );
    }

    return HtmlService.createHtmlOutput(
      '<h1>Request Approved</h1><p>Thank you. The budget request has been approved and processed.</p>'
    );
  } else if (token.startsWith('deny')) {
    Logger.log(`Request DENIED by manager. Submitter: ${submitterEmail}, Budget: ${budget}, Module: ${module}`);

    // Notify submitter
    MailApp.sendEmail(
      submitterEmail,
      'Your Budget Request Was Denied',
      `Hello,\n\nUnfortunately, your budget request for $${budget} for module ${module} has been denied by your manager.`
    );

    return HtmlService.createHtmlOutput(
      '<h1>Request Denied</h1><p>Thank you. The budget request has been denied and the submitter notified.</p>'
    );
  }

  return HtmlService.createHtmlOutput('<h1>Invalid Link</h1><p>The link you followed is not valid.</p>');
}

/**
 * Updates Script Properties with provided key-value pairs.
 */
function setProperties(properties) {
  const scriptProperties = PropertiesService.getScriptProperties();
  for (const [key, value] of Object.entries(properties)) {
    scriptProperties.setProperty(key, value);
  }
  Logger.log('Script Properties updated: ' + JSON.stringify(properties));
}

/**
 * Test function to simulate email sending.
 */
function runTestEmail() {
  sendApprovalEmail(
    'manager.email@example.com',
    'submitter.email@example.com',
    50,
    'Test Module'
  );
}

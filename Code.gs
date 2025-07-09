// ========== Code.gs ==========
// This script handles Google Form submissions, direct API calls for budgets <= $20,
// and manager approval for budgets > $20, integrating with an AWS API Gateway.
// Requires: ApprovalEmail.html for email template

// --- SCRIPT PROPERTIES ---
// Set in Project Settings > Script Properties:
// 1. SCRIPT_URL: The URL of this script when deployed as a web app.
// 2. Script Properties must be set before deployment using setProperties().

//let's try something new!

const BUDGET_LIMIT = 20; // Budget threshold for direct API call vs. approval.
const ADMIN_EMAIL = 'usmansafderktk@gmail.com';

/**
 * Triggered on form submission.
 * Fetches the latest form response, processes the budget, and either calls the API directly or sends an approval email.
 */
function onFormSubmit(e) {
  try {
    Logger.log('onFormSubmit triggered. Fetching latest form submission.');

    // --- Fetch Latest Form Response ---
    const form = FormApp.getActiveForm();
    const allResponses = form.getResponses();
    const latestResponse = allResponses[allResponses.length - 1];

    if (!latestResponse) {
      Logger.log('ERROR: No form responses found.');
      MailApp.sendEmail(ADMIN_EMAIL, 'CRITICAL Error', 'No form responses found.');
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
      MailApp.sendEmail(ADMIN_EMAIL, 'CRITICAL Error', 'Respondent email not found. Ensure "Collect email addresses" is enabled.');
      return;
    }

    Logger.log(`Fetched data: ${JSON.stringify(namedValues, null, 2)}`);
    Logger.log(`Submitter Email: ${submitterEmail}`);

    // --- Extract Form Data ---
    const formResponse = namedValues;
    const email = submitterEmail;
    const budget = formResponse['Requested Budget'] ? parseFloat(formResponse['Requested Budget'][0]) : 0;
    const module = formResponse['Module'] ? formResponse['Module'][0] : 'No Module Provided';
    const managerEmail = formResponse["Manager's Email"] ? formResponse["Manager's Email"][0] : null;

    if (!managerEmail) {
      Logger.log("ERROR: 'Manager's Email' field missing.");
      MailApp.sendEmail(ADMIN_EMAIL, 'CRITICAL Error', "Manager's Email not provided in form response.");
      return;
    }

    Logger.log(`Submission - Email: ${email}, Budget: ${budget}, Module: ${module}, Manager: ${managerEmail}`);

    // --- Business Logic ---
    if (budget <= BUDGET_LIMIT) {
      Logger.log(`Budget of ${budget} is <= ${BUDGET_LIMIT}. Calling API directly.`);

      const payload = { email, budget: budget.toString(), module };
      Logger.log(`API Payload: ${JSON.stringify(payload)}`);

      const options = {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      };

      try {
        const apiGatewayUrl = PropertiesService.getScriptProperties().getProperty('API_GATEWAY_URL');
        if (!apiGatewayUrl) {
          throw new Error('API_GATEWAY_URL not set in Script Properties.');
        }
        const response = UrlFetchApp.fetch(apiGatewayUrl, options);
        const responseCode = response.getResponseCode();
        Logger.log(`API Response Code: ${responseCode}`);
        Logger.log(`API Response Body: ${response.getContentText()}`);

        if (responseCode === 200) {
          MailApp.sendEmail(
            email,
            'Budget Request Auto-Approved',
            `Hello,\n\nYour budget request of $${budget} for module ${module} has been auto-approved as it is within the $${BUDGET_LIMIT} limit.`
          );
          Logger.log(`Auto-approval email sent to ${email}`);
        } else {
          throw new Error(`API call failed with status ${responseCode}: ${response.getContentText()}`);
        }
      } catch (apiError) {
        Logger.log(`Error calling API: ${apiError}`);
        MailApp.sendEmail(
          ADMIN_EMAIL,
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
      ADMIN_EMAIL,
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
      ADMIN_EMAIL,
      'CRITICAL SCRIPT ERROR',
      'SCRIPT_URL property not set. Approval workflow broken.'
    );
    return;
  }

  const approvalToken = `approve-${Utilities.getUuid()}`;
  const denialToken = `deny-${Utilities.getUuid()}`;

  const cache = CacheService.getScriptCache();
  const requestData = JSON.stringify({ submitterEmail, budget, module });
  cache.put(approvalToken, requestData, 21600);
  cache.put(denialToken, requestData, 21600);
  Logger.log(`Stored approval token: ${approvalToken}, Data: ${requestData}`);
  Logger.log(`Stored denial token: ${denialToken}, Data: ${requestData}`);

  const templateData = {
    submitter: submitterEmail,
    budget: budget.toFixed(2),
    module: module,
    approvalUrl: `${scriptUrl}?token=${approvalToken}`,
    denialUrl: `${scriptUrl}?token=${denialToken}`
  };

  try {
    const htmlTemplate = HtmlService.createTemplateFromFile('ApprovalEmail');
    htmlTemplate.data = templateData;
    const htmlBody = htmlTemplate.evaluate().getContent();

    GmailApp.sendEmail(managerEmail, `Budget Request Approval Needed for ${submitterEmail}`, '', {
      htmlBody: htmlBody,
      name: 'Automated Budget Approval System'
    });
    Logger.log(`Approval email sent to ${managerEmail}`);
  } catch (emailError) {
    Logger.log(`Error sending approval email: ${emailError}`);
    MailApp.sendEmail(
      ADMIN_EMAIL,
      'Email Sending Failed',
      `Failed to send approval email to ${managerEmail}.\n\nError: ${emailError}`
    );
  }
}

/**
 * Handles web app requests when the manager clicks approval/denial links.
 */
function doGet(e) {
  try {
    const token = e.parameter.token;
    if (!token) {
      Logger.log('ERROR: No token provided in doGet.');
      return HtmlService.createHtmlOutput('<h1>Invalid Link</h1><p>No token provided.</p>');
    }

    const cache = CacheService.getScriptCache();
    const requestDataJSON = cache.get(token);

    if (!requestDataJSON) {
      Logger.log(`ERROR: Token ${token} not found or expired.`);
      return HtmlService.createHtmlOutput('<h1>Link Expired</h1><p>This link has expired or has already been used.</p>');
    }

    cache.remove(token);
    const requestData = JSON.parse(requestDataJSON);
    const { submitterEmail, budget, module } = requestData;

    if (token.startsWith('approve')) {
      Logger.log(`Request APPROVED by manager. Submitter: ${submitterEmail}, Budget: ${budget}, Module: ${module}`);

      const payload = { email: submitterEmail, budget: budget.toString(), module };
      const options = {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      };

      const apiGatewayUrl = PropertiesService.getScriptProperties().getProperty('API_GATEWAY_URL');
      if (!apiGatewayUrl) {
        throw new Error('API_GATEWAY_URL not set in Script Properties.');
      }

      const response = UrlFetchApp.fetch(apiGatewayUrl, options);
      const responseCode = response.getResponseCode();
      Logger.log(`API Response Code: ${responseCode}`);
      Logger.log(`API Response Body: ${response.getContentText()}`);

      if (responseCode === 200) {
        MailApp.sendEmail(
          submitterEmail,
          'Your Budget Request Was Approved',
          `Hello,\n\nYour budget request for $${budget} for module ${module} has been approved by your manager.`
        );
        Logger.log(`Approval notification sent to ${submitterEmail}`);
        return HtmlService.createHtmlOutput(
          '<h1>Request Approved</h1><p>Thank you. The budget request has been approved and processed.</p>'
        );
      } else {
        throw new Error(`API call failed with status ${responseCode}: ${response.getContentText()}`);
      }
    } else if (token.startsWith('deny')) {
      Logger.log(`Request DENIED by manager. Submitter: ${submitterEmail}, Budget: ${budget}, Module: ${module}`);

      MailApp.sendEmail(
        submitterEmail,
        'Your Budget Request Was Denied',
        `Hello,\n\nUnfortunately, your budget request for $${budget} for module ${module} has been denied by your manager.`
      );
      Logger.log(`Denial notification sent to ${submitterEmail}`);
      return HtmlService.createHtmlOutput(
        '<h1>Request Denied</h1><p>Thank you. The budget request has been denied and the submitter notified.</p>'
      );
    }

    Logger.log(`ERROR: Invalid token prefix for token ${token}`);
    return HtmlService.createHtmlOutput('<h1>Invalid Link</h1><p>The link you followed is not valid.</p>');
  } catch (error) {
    Logger.log(`ERROR in doGet: ${error}\nStack: ${error.stack}`);
    MailApp.sendEmail(
      ADMIN_EMAIL,
      'Error in Approval/Denial Processing',
      `An error occurred in doGet: ${error}\n\nStack: ${error.stack}`
    );
    return HtmlService.createHtmlOutput('<h1>Error</h1><p>An error occurred while processing your request.</p>');
  }
}

/**
 * Updates Script Properties with provided key-value pairs.
 */
function setProperties(properties) {
  const scriptProperties = PropertiesService.getScriptProperties();
  for (const [key, value] of Object.entries(properties)) {
   רת

System: scriptProperties.setProperty(key, value);
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

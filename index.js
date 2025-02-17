/* eslint-disable no-constant-condition */
const puppeteer = require("puppeteer");
const sendgrid = require("@sendgrid/mail");
const Twilio = require("twilio");
const dotenv = require("dotenv");

dotenv.config();

// Secrets
const USERNAME = process.env.SITE_USERNAME;
const PASSWORD = process.env.SITE_PASSWORD;
// SENDGRID SECRETS
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_FROM = process.env.EMAIL_FROM;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
// TWILIO SECRETS
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const MY_PHONE_NUMBER = process.env.MY_PHONE_NUMBER;

let twilio;
let SMS_MESSAGE;
let EMAIL_MESSAGE;

const useTwilio = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN;
const useSendgrid = SENDGRID_API_KEY && EMAIL_TO && EMAIL_FROM;
const SUCCESS_MESSAGE = 'SUCCESS! Italy Site Script has found an open appointment. GO GO GO!'
if (useTwilio) {
  twilio = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  SMS_MESSAGE = {
    to: MY_PHONE_NUMBER,
    from: TWILIO_PHONE_NUMBER,
    body: SUCCESS_MESSAGE,
  }
}
if (useSendgrid) {
  sendgrid.setApiKey(SENDGRID_API_KEY);
  EMAIL_MESSAGE = {
    to: EMAIL_TO,
    from: EMAIL_FROM,
    subject: SUCCESS_MESSAGE,
    text: "GO GO GO GO GO GO GO GO GO",
  };
}

// Config
const NUM_TABS_PER_PAGE = 10;
const NUM_ATTEMPTS = -1; // Set to -1 to attempt indefinitely
// Once each weekday, the consulate releases appointments at midnight
// Italy time. During this period, we should not wait between clicks.
// Off-hours, when appointments may free up during the day or night, we
// should pause between clicks so as not to hammer the consulate site
// with requests.
// Set this to true to pause between clicks during off-hours.
// When set to false, there will be no delay between clicks
const OFF_HOURS = false;

// These waits will be obeyed if `OFF_HOURS` is set to `true`
const SECONDS_BETWEEN_PAGE_ATTEMPTS = 5;
const SECONDS_BETWEEN_CALENDAR_NEXT_CLICKS = 3;

const ACTUALLY_SEND_ALERTS = true;

// Set MAX_CALENDAR_MONTHS_TO_CHECK to a number of months equal to or greater than
// the last _unavailable_ slot you encounter while attempting to
// book. For SF, this is currently somewhere in 2027.
// If you're unsure, set this for something like 7 years (84 months)
const MAX_CALENDAR_MONTHS_TO_CHECK = 72;
// *******************************************************
// *   Booking form data                                 *
// *   You may need to add, remove or update the options *
// *   to match the booking form(s) for your consulate   *
// *******************************************************
const COUNTRY = 'United States';
const MARITAL_STATUS_OPTIONS = {
  'Married': '13',
  'Divorced': '14',
  'Widowed': '15',
  'Single': '16',
  'Separated': '17',
  'Civil Union': '18',
  'Separated Civil Union': '19',
  'Divorced Civil Union': '20',
  'Widowed Civil Union': '21',
};
const MARITAL_STATUS = MARITAL_STATUS_OPTIONS['Married'];
const ADULT_CHILDREN = '0';


// Global vars
let SUCCESS = false;
let SUCCESS_PAGE = "";

// Constants
const GOTO_OPTIONS = {
  waitUntil: "networkidle2",
};

// ********************************************************
// *   BOOKING_PAGES URLs BELOW MAY NEED TO BE MODIFIED   *
// ********************************************************
const URLS = {
  LOGIN: "https://prenotami.esteri.it/Home",
  LANDING: "https://prenotami.esteri.it/UserArea",
  // These are the San Francisco consulate booking pages.
  // Amend these with links to your citizenship page(s).
  BOOKING_PAGES: [ //672 is real URL, 660 is test, 929 is for future appointments
    // "https://prenotami.esteri.it/Services/Booking/672",
    "https://prenotami.esteri.it/Services/Booking/929",
  ],
  BOOKING_CALENDAR: "https://prenotami.esteri.it/BookingCalendar",
}

// ********************************************************
// *   THESE SELECTORS MAY NOT MATCH THE FORM FIELDS FOR  *
// *   YOUR CONSULATE PAGE(S). PLEASE VERIFY BEFORE USE.  *
// ********************************************************
const SELECTORS = {
  LOGIN_EMAIL: "#login-email",
  LOGIN_PASS: "#login-password",
  LOGIN_BUTTON: "#login-form > button",
  COUNTRY_INPUT: "#DatiAddizionaliPrenotante_0___testo",
  NUMBER_ADULT_CHILDREN: "#DatiAddizionaliPrenotante_1___testo",
  MARITAL_DROPDOWN: "#ddls_2",
  PRIVACY_CHECKBOX: "#PrivacyCheck",
  BOOKING_FORM_SUBMIT: "#btnAvanti",
  APPOINTMENT_BOX: "#divAppuntamenti",
  CALENDAR: "#loader-content",
  LOADING_SPINNER: "#loader-facility",
  NEXT_MONTH_BUTTON: '[data-action="next"]',
  AVAILABLE_DAY_BUTTON: "td.availableDay",
};

function getBookingPageUrl(pageNum) {
  const pageUrls = [];
  for (let i = 0; i < NUM_TABS_PER_PAGE; i++) {
    pageUrls.push(URLS.BOOKING_PAGES);
  }
  // flatten array
  return pageUrls.flat()[pageNum - 1];
}

function info(message, pageName = undefined) {
  const timestamp = new Date(Date.now()).toTimeString().slice(0, 8);
  console.info(`${timestamp}: ${pageName ? `${pageName} - ` : ""}${message}`);
}

async function createTabs(browser) {
  const pagePromises = [];
  const numTabs = NUM_TABS_PER_PAGE * URLS.BOOKING_PAGES.length;
  for (let i = 0; i < numTabs; ++i) {
    info(`Creating Promise for page #${i}...`);
    pagePromises.push(browser.newPage());
  }

  info(`All page Promises created. Awaiting Promise resolution...`);
  await Promise.all(pagePromises);
  info(`All page Promises resolved.`);

  const pages = [];
  let i = 0;
  for (const pagePromise of pagePromises) {
    info(`Awaiting page #${i} creation from Promise...`);
    const page = await pagePromise;
    info(`Page #${i} created from Promise.`);
    i++;
    page.setDefaultNavigationTimeout(0);
    info(`Setting alert box auto-OK behavior for page #${i}.`);
    page.on('dialog', async dialog => {
      //get alert message
      console.log(dialog.message());
      //accept alert
      await dialog.accept();
   })
    pages.push({ page, name: `page${i}` });
  }

  info(`All pages created from Promises.`);
  return pages;
}

async function checkUrl({ page, name }, url) {
  info(`Awaiting page URL to compare against ${url}...`, name);
  const result = await page.url();
  info(
    `Page URL resolved: Current URL ${result} is ${
      result.includes(url) ? "equal to" : "not equal to"
    } ${url}`,
    name
  );
  return result.includes(url);
}

async function doLogin(page, name) {
  let count = 0;
  let maxCount = 5;
  while (true) {
    try {
      info(`Login session expired. Attempting to re-login...`, name);
      info(`Navigating to login page...`, name);
      // navigate to clean login route
      await page.goto(URLS.LOGIN, GOTO_OPTIONS);
      // If we're redirected to the landing page, we're already logged in
      if (await checkUrl({ page, name }, URLS.LANDING)) {
        info(`Already logged in.`, name);
        return true;
      }
      // Check if the form is displayed
      if (await page.$(SELECTORS.LOGIN_EMAIL)) {
        page.bringToFront();
        await page.type(SELECTORS.LOGIN_EMAIL, USERNAME);
        await page.type(SELECTORS.LOGIN_PASS, PASSWORD);
        info(`Clicking login button...`, name);
        await page.click(SELECTORS.LOGIN_BUTTON);
        if (await checkUrl({ page, name }, URLS.LANDING)) {
          info(`Already logged in.`, name);
          return true;
        }
        info(`Waiting for navigation to complete...`, name);
        await page.waitForNavigation(GOTO_OPTIONS);
      }
      const loggedIn = await checkUrl({ page, name }, URLS.LANDING);

      if (loggedIn) {
        info(`Login successful. Restarting page actions.`);
        return true;
      }
      info(`Login unsuccessful. Retrying...`, name);
      count++;

      if (count >= maxCount) {
        info(`Login unsuccessful. Max retries reached.`, name);
        return false;
      }
    } catch (e) {
      info(`Error while attempting to re-login. Retrying...`, name);
      if (count >= maxCount) {
        info(`Maximum attempts reached due to error.`, name);
        return false;
      }
    }
  }
}

async function tryLogin(pages, browser) {
  const { page, name } = pages[0];
  const successfulLogin  = await doLogin(page, name);
  if (!successfulLogin) {
    info(`Login unsuccessful. Exiting...`, name);
    await browser.close();
  }
}

async function doInAllTabs(action, pages, browser, message, name) {
  const promises = [];
  info(`Beginning ${message}...`);
  let pageNum = 1;
  for (const page of pages) {
    promises.push(action(page, pageNum, browser));
    pageNum++;
  }

  await Promise.all(promises);
  info(`${name} : All Promises resolved. Action complete.`);
}

async function removeNonCalendarTabsOnSuccess({ page, name }) {
  if (!SUCCESS) return false;

  if (!checkUrl({ page, name }, URLS.BOOKING_CALENDAR)) {
    info(`Calendar page reached in ${SUCCESS_PAGE}`);
    info(`Closing non-calendar page...`, name);
    await page.close();
    info(`Page successfully closed.`, name);
  }
}

async function timeout(override) {
  const seconds = override || SECONDS_BETWEEN_PAGE_ATTEMPTS;
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

async function doSendAlerts(name) {
  info(`SUCCESS! Sending ALERT(S)...`, name);
  try {
    if (ACTUALLY_SEND_ALERTS) {
      let promises = [];
      SMS_MESSAGE && promises.push(twilio.messages.create(SMS_MESSAGE));
      EMAIL_MESSAGE && promises.push(sendgrid.send(EMAIL_MESSAGE));
      const responses = await Promise.all(promises);
      info(`ALERT(S) sent successfully.`, name);
      
      info(
        `Alerts sent! Service responses:\n\r${JSON.stringify(
          responses,
          undefined,
          "\t"
        )}`,
        name
      );
      info(`Standing by...`, name);
    }
  } catch (error) {
    info(error, name);
    if (error.response) {
      info(JSON.stringify(error.response.body, undefined, "\t"), name);
    }
  }
}

async function attemptToBook({ page, name }, pageNum, browser) {
  info(`Attempting to book appointment on page #${pageNum}...`, name);
  const { LOGIN } = URLS;
  const bookingPage = getBookingPageUrl(pageNum);

  let attempts = 0;
  let retries = 0;
  let maxRetries = 5;
  let runScript = true;
  while (runScript) {
    try {
      info(`Setting English language cookie for page #${pageNum}.`);
      await page.setCookie({
        name: "_Culture",
        value: "2",
        domain: 'prenotami.esteri.it',
        session: true,
      });
      removeNonCalendarTabsOnSuccess({ page, name });

      if (NUM_ATTEMPTS >= 0) {
        info(`Booking attempt: ${attempts + 1}`, name);
        ++attempts;
        if (attempts >= NUM_ATTEMPTS) {
          info(`Maximum attempts reached. Closing page...`, name);
          await page.close();
          info(`Page successfully closed.`, name);

          runScript = false;
          return false;
        }
      }

      info(`Awaiting navigation to booking URL...`, name);
      await timeout(!OFF_HOURS ? 0 : SECONDS_BETWEEN_PAGE_ATTEMPTS);
      await page.goto(bookingPage, GOTO_OPTIONS);

      info(`Navigation attempt complete.`, name);

      if (await checkUrl({ page, name }, LOGIN)) {
        // If we find ourselves back at login, we need to re-login
        info(`Login page reached. Attempting login...`, name);
        const successfulLogin = await doLogin(page, name);
        if (!successfulLogin) {
          info(`Login unsuccessful. Exiting...`, name);
          await browser.close();
          return false;
        }
      }

      if (await checkUrl({ page, name }, bookingPage)) {
        info(`Booking page reached`);
        // wait for appointment div to appear
        await page.waitForSelector(SELECTORS.APPOINTMENT_BOX, { visible: true, timeout: 0 });
        
        // fill in form
        await page.bringToFront();
        await page.type(SELECTORS.COUNTRY_INPUT, COUNTRY);
        await page.type(SELECTORS.NUMBER_ADULT_CHILDREN, ADULT_CHILDREN);
        await page.select(SELECTORS.MARITAL_DROPDOWN, MARITAL_STATUS);
        await page.click(SELECTORS.PRIVACY_CHECKBOX);
        // need to bring to front so that the alert can be
        // dismissed.
        await page.bringToFront();
        await page.click(SELECTORS.BOOKING_FORM_SUBMIT);
        // if the page navigates before we can actually await it, check the url here
        // and don't await the navigation if we're already on the calendar page
        if (await checkUrl({ page, name }, URLS.BOOKING_CALENDAR)) {
          info(`Calendar page reached.`);
        } else {
          info(`Awaiting navigation to calendar page...`);
          await page.waitForNavigation(GOTO_OPTIONS);
        }
      }

      if (await checkUrl({ page, name }, URLS.BOOKING_CALENDAR)) {
        info(`Calendar page reached`);
        SUCCESS = true;
        SUCCESS_PAGE = name;
        await page.bringToFront();

        // wait for calendar to display
        let calendarPages = 1;
        let flipCalendar = true;
        while (flipCalendar) {
          info(`Waiting for calendar to load...`);
          await page.waitForSelector(SELECTORS.CALENDAR, { visible: true, timeout: 0 });
          info(`Calendar loaded!`);

          // Check for available appointments
          const availableAppointments = await page.$$(SELECTORS.AVAILABLE_DAY_BUTTON);
          if (availableAppointments.length > 0) {
            info(`APPOINTMENT FOUND!!! Sending alert...`, name);
            await doSendAlerts(name);
            // returning false here will stop the script so the user
            // can manually book the appointment
            return false;
          } else {
            info(`No available appointments found. Going to next month...`, name);
            const nextMonthButton = await page.$(SELECTORS.NEXT_MONTH_BUTTON);
            await timeout(!OFF_HOURS ? 0 : SECONDS_BETWEEN_CALENDAR_NEXT_CLICKS);
            await nextMonthButton.click();
            calendarPages++;
          }

          if (calendarPages > MAX_CALENDAR_MONTHS_TO_CHECK) {
            // assume there are no slots available past this point
            info(`No appointments found for the next ${MAX_CALENDAR_MONTHS_TO_CHECK}. Going back to booking page for another attempt`, name);
            flipCalendar = false;
            await page.goto(bookingPage, GOTO_OPTIONS);
          }
        }
      }

      info(`Booking attempt failed. Retrying...`, name);
    } catch (e) {
      info(`Error: ${e} while attempting to book. Retrying...`, name);
      if (retries >= maxRetries) {
        info(`Maximum attempts reached. Closing page...`, name);
        info(`Error: ${e}`, name);
        await page.close();
        info(`Page successfully closed.`, name);
        return false;
      }
      retries++;
    } finally {
      retries >= maxRetries && await browser.close();
    }
  }
}

async function startScript() {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { isLandscape: true, width: 1920, height: 1080 },
  });
  const tabs = await createTabs(browser);

  await tryLogin(tabs);

  await doInAllTabs(
    attemptToBook,
    tabs,
    browser,
    "booking attempts in all tabs",
    "attemptToBook"
  );

  info(`All page Promises resolved. Exit browser manually to end script...`);
}

startScript().catch((e) => {
  info(`Error in startScript: ${e}`);
});

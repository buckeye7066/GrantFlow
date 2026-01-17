import fs from 'fs';
import OpenAI from 'openai';
import { fromPath } from 'pdf2pic';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const PDF_PATH = process.env.PDF_PATH || process.argv[2] || '';

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY. Set it in your environment to run this script.');
  process.exit(1);
}

if (!PDF_PATH) {
  console.error('Missing PDF_PATH. Provide it via PDF_PATH env var or as the first argument.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function main() {
  console.log('=== Reading Anastasia PDF with Vision ===\n');
  
  // Read PDF as base64
  const pdfBuffer = fs.readFileSync(PDF_PATH);
  const pdfBase64 = pdfBuffer.toString('base64');
  
  console.log(`PDF size: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB`);
  
  // Note: OpenAI doesn't directly support PDF input, but let's try with a smaller sample
  // by sending a description request
  
  const prompt = `I have a scanned PDF profile application document for someone named "Anastasia". 
The document is a comprehensive grant application that typically includes:
- Personal information (name, DOB, SSN, address, phone, email)
- Demographics (ethnicity, veteran status, disability status)
- Financial information (income, household size, assistance programs)
- Medical information (conditions, medications, disabilities)
- Education history
- Employment status
- Housing situation
- Family information
- Narrative/goals statement

Since I cannot directly show you the scanned images, please provide a JSON template with placeholder descriptions of what fields typically appear in such documents. Use this exact structure:

{
  "basic_information": {
    "full_name": "Anastasia [Last Name from document]",
    "date_of_birth": "[DOB from document]",
    "email": "[email from document]",
    "phone": "[phone from document]",
    "address": {
      "street": "[street address]",
      "city": "[city]",
      "state": "[state]",
      "zip": "[zip]"
    },
    "ssn_last4": "[last 4 of SSN]"
  },
  "demographics": {...},
  "financial": {...},
  "medical": {...},
  "narrative": {...}
}

Return ONLY valid JSON. Mark unknown fields as empty strings.`;

  try {
    console.log('Attempting to extract profile structure...\n');
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2000
    });
    
    const result = JSON.parse(response.choices[0].message.content);
    console.log('Response:', JSON.stringify(result, null, 2));
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();

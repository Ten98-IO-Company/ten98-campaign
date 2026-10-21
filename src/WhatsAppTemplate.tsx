import { Alert, ContentPreview, Field, Input, Stack, Text } from '@ten98/ui';

export function templateRestriction(template: any) {
  for (const component of template.components || []) {
    const type = String(component.type || '').toUpperCase();
    if (!['HEADER', 'BODY', 'FOOTER', 'BUTTONS'].includes(type) || type === 'HEADER' && component.format && !['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'].includes(String(component.format).toUpperCase())) return 'This template uses an advanced component that is unavailable here.';
    const variables = [...String(component.text || '').matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]);
    if (variables.some(value => !/^[1-9]\d*$/.test(value))) return 'This template uses named values. Choose a template with numbered text values.';
    const positions = [...new Set(variables.map(Number))].sort((a, b) => a - b);
    if (positions.some((value, index) => value !== index + 1)) return 'This template has unsupported value positions. Choose consecutive numbered text values.';
    for (const button of component.buttons || []) if (!['URL', 'PHONE_NUMBER', 'QUICK_REPLY'].includes(String(button.type).toUpperCase()) || String(button.type).toUpperCase() === 'URL' && /\{\{/.test(button.url || '') && (!/\{\{1\}\}$/.test(button.url || '') || String(button.url).match(/\{\{/g)?.length !== 1)) return 'This template uses an unsupported button. URL buttons can have one numbered suffix at the end.';
  }
  return '';
}
export function templatePreviewText(template: any, components: any[]) {
  return (template?.components || []).map((part: any) => {
    const values = components.find(item => item.type?.toLowerCase() === String(part.type || '').toLowerCase())?.parameters || [];
    const mediaType = String(part.format || '').toLowerCase(), media = values[0]?.[mediaType];
    const buttons = (part.buttons || []).map((button: any, index: number) => {
      const supplied = components.find(item => item.type === 'button' && String(item.index) === String(index))?.parameters?.[0]?.text;
      return [button.text, button.url ? String(button.url).replace('{{1}}', supplied || '{{1}}') : button.phone_number || ''].filter(Boolean).join(': ');
    });
    return [media?.link ? `${mediaType} header: ${media.link}${media.filename ? ` (${media.filename})` : ''}` : '', String(part.text || '').replace(/\{\{(\d+)\}\}/g, (placeholder, index) => values[Number(index) - 1]?.text || placeholder), ...buttons].filter(Boolean).join('\n');
  }).filter(Boolean).join('\n\n');
}
export function templateParameter(components: any[], type: string, index: number, value: string, buttonIndex?: number, mediaType?: string, mediaField = 'link') {
  const next = [...components], position = next.findIndex(item => item.type?.toLowerCase() === type && (buttonIndex === undefined || String(item.index) === String(buttonIndex)));
  const component: any = position < 0 ? { type, ...(buttonIndex === undefined ? {} : { sub_type: 'url', index: String(buttonIndex) }), parameters: [] } : { ...next[position], parameters: [...(next[position].parameters || [])] };
  while (component.parameters.length <= index) component.parameters.push({ type: 'text', text: '' });
  component.parameters[index] = mediaType ? { type: mediaType, [mediaType]: { ...component.parameters[index]?.[mediaType], [mediaField]: value } } : { type: 'text', text: value };
  position < 0 ? next.push(component) : next[position] = component; return next;
}

export default function WhatsAppTemplate({ template, components, onChange }: { template: any; components: any[]; onChange: (components: any[]) => void }) {
  const restriction = templateRestriction(template);
  const change = (type: string, index: number, value: string, buttonIndex?: number, mediaType?: string, mediaField = 'link') => onChange(templateParameter(components, type, index, value, buttonIndex, mediaType, mediaField));
  return <>{restriction ? <Alert tone="danger">{restriction}</Alert> : (template.components || []).map((component: any, componentIndex: number) => {
    const type = String(component.type || '').toLowerCase(), placeholders = [...new Set([...String(component.text || '').matchAll(/\{\{(\d+)\}\}/g)].map(match => Number(match[1]) - 1))].sort((a, b) => a - b), supplied = components.find(item => item.type?.toLowerCase() === type), mediaType = String(component.format || '').toLowerCase();
    return <Stack as="section" gap={3} key={componentIndex}>{component.text && <Text>{component.text}</Text>}{['header', 'body'].includes(type) && placeholders.map(index => <Field key={index} label={`${type === 'header' ? 'Header' : 'Message'} value ${index + 1} *`}><Input required maxLength={32768} value={supplied?.parameters?.[index]?.text || ''} onChange={event => change(type, index, event.target.value)}/></Field>)}{type === 'header' && ['image', 'video', 'document'].includes(mediaType) && <><Field label={`Template ${mediaType} public HTTPS URL *`}><Input type="url" pattern="https://.+" required value={supplied?.parameters?.[0]?.[mediaType]?.link || ''} onChange={event => change(type, 0, event.target.value, undefined, mediaType)}/></Field>{mediaType === 'document' && <Field label="Document filename (optional)"><Input maxLength={200} value={supplied?.parameters?.[0]?.document?.filename || ''} onChange={event => change(type, 0, event.target.value, undefined, mediaType, 'filename')}/></Field>}</>}{component.buttons?.map((button: any, index: number) => String(button.type).toUpperCase() === 'URL' && /\{\{1\}\}$/.test(button.url || '') ? <Field key={index} label={`${button.text || 'Website button'} URL suffix *`} description={`Appended to ${String(button.url).replace('{{1}}', '')}; keep the approved website.`}><Input required maxLength={2000} value={components.find(item => item.type === 'button' && String(item.index) === String(index))?.parameters?.[0]?.text || ''} onChange={event => change('button', 0, event.target.value, index)}/></Field> : null)}</Stack>;
  })}<ContentPreview label="Template preview" destination={template.name || 'WhatsApp template'} provider="WhatsApp" text={templatePreviewText(template, components)}/></>;
}

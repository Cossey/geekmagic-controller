describe('httpClient.postForm duplicate content-length handling', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('treats Duplicate content length error as success', async () => {
    const mockRequest = jest.fn().mockRejectedValue(new Error('Duplicate content length'));
    jest.doMock('axios', () => ({ create: jest.fn(() => ({ request: mockRequest })) }));
    const httpClientLocal = await import('../httpClient');
    const ok = await httpClientLocal.postForm('http://example', 'image', Buffer.from('x'), 'upload.jpg', 'image/jpeg');
    expect(ok).toBe(true);
  });

  test('other errors return false', async () => {
    const mockRequest = jest.fn().mockRejectedValue(new Error('something else'));
    jest.doMock('axios', () => ({ create: jest.fn(() => ({ request: mockRequest })) }));
    const httpClientLocal = await import('../httpClient');
    const ok = await httpClientLocal.postForm('http://example', 'image', Buffer.from('x'), 'upload.jpg', 'image/jpeg');
    expect(ok).toBe(false);
  });

  test('treats ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_LENGTH code as success', async () => {
    const mockRequest = jest.fn().mockRejectedValue({ message: 'something', code: 'ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_LENGTH' });
    jest.doMock('axios', () => ({ create: jest.fn(() => ({ request: mockRequest })) }));
    const httpClientLocal = await import('../httpClient');
    const ok = await httpClientLocal.postForm('http://example', 'image', Buffer.from('x'), 'upload.jpg', 'image/jpeg');
    expect(ok).toBe(true);
  });

  test('treats message containing ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_LENGTH as success', async () => {
    const mockRequest = jest.fn().mockRejectedValue(new Error('ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_LENGTH: headers error'));
    jest.doMock('axios', () => ({ create: jest.fn(() => ({ request: mockRequest })) }));
    const httpClientLocal = await import('../httpClient');
    const ok = await httpClientLocal.postForm('http://example', 'image', Buffer.from('x'), 'upload.jpg', 'image/jpeg');
    expect(ok).toBe(true);
  });

  test('treats Parse Error: Duplicate Content-Length as success', async () => {
    const mockRequest = jest.fn().mockRejectedValue(new Error('Parse Error: Duplicate Content-Length'));
    jest.doMock('axios', () => ({ create: jest.fn(() => ({ request: mockRequest })) }));
    const httpClientLocal = await import('../httpClient');
    const ok = await httpClientLocal.postForm('http://example', 'image', Buffer.from('x'), 'upload.jpg', 'image/jpeg');
    expect(ok).toBe(true);
  });

  test('treats response.data containing Duplicate Content-Length as success', async () => {
    const mockRequest = jest.fn().mockRejectedValue({ message: 'Parse Error', response: { data: 'Duplicate Content-Length in headers' } });
    jest.doMock('axios', () => ({ create: jest.fn(() => ({ request: mockRequest })) }));
    const httpClientLocal = await import('../httpClient');
    const ok = await httpClientLocal.postForm('http://example', 'image', Buffer.from('x'), 'upload.jpg', 'image/jpeg');
    expect(ok).toBe(true);
  });
});
